const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const API_KEY = process.env.SILICONFLOW_API_KEY || '';
const API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = 'deepseek-ai/DeepSeek-V3';
const MAX_DISCUSS_TIME = 10 * 60 * 1000;
const API_TIMEOUT = 30000;

console.log('========================================');
console.log('服务器启动中...');
console.log('API_KEY 存在:', !!API_KEY);
console.log('模型:', MODEL);
console.log('========================================');

const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function generateBotId() {
  return 'bot_' + Math.random().toString(36).substring(2, 8);
}

function getPlayersList(room) {
  const list = [];
  room.players.forEach((info, id) => {
    list.push({ id, nickname: info.nickname, isHost: id === room.host, isBot: false });
  });
  room.bots.forEach((info, id) => {
    list.push({ id, nickname: info.nickname, isHost: false, isBot: true });
  });
  return list;
}

function getRuleCounts(playerCount) {
  const totalRules = playerCount * 2;
  let falseCount;
  if (playerCount <= 4) falseCount = 1;
  else if (playerCount <= 6) falseCount = 2;
  else falseCount = 3;
  return { totalRules, trueCount: totalRules - falseCount, falseCount };
}

// ==================== AI 生成案件（唯一来源） ====================
async function generateCase(playerCount) {
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`\n===== AI生成案件 ===== 玩家:${playerCount} 真:${trueCount} 假:${falseCount}`);
  
  if (!API_KEY) {
    console.log('无API_KEY，使用内置兜底');
    return getFallbackCase(trueCount, falseCount);
  }

  const prompt = `生成一个推理案件。输出纯JSON，不要markdown。

硬性要求：
- 3个嫌疑人，每个嫌疑人的名字至少出现在2条规则中
- 严格输出${trueCount}条真规则，${falseCount}条假规则
- 每条规则不超过20字，用简洁陈述句
- 所有真规则合起来必须唯一指向凶手，缺任何一条都无法确定
- 假规则与真规则形成逻辑矛盾，但不能是直接否定句式
- 避免"监控坏了""不在场证明"等套路

输出格式：
{"caseTitle":"≤8字","caseDescription":"≤40字","suspects":["名1","名2","名3"],"murderer":"凶手名","trueRules":["规则"...共${trueCount}条],"falseRules":["规则"...共${falseCount}条],"reasoning":"≤80字推理链"}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`第${attempt}次尝试...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.9 + attempt * 0.05, max_tokens: 1500 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const p = JSON.parse(content);
        if (p.caseTitle && p.murderer && p.trueRules?.length >= trueCount && p.falseRules?.length >= falseCount) {
          console.log('✅ 成功:', p.caseTitle, '| 凶手:', p.murderer);
          return {
            caseTitle: p.caseTitle, caseDescription: p.caseDescription || '',
            suspects: p.suspects || ['A', 'B', 'C'], murderer: p.murderer,
            trueRules: p.trueRules.slice(0, trueCount),
            falseRules: p.falseRules.slice(0, falseCount),
            reasoning: p.reasoning || ''
          };
        }
        console.log('数据不完整，重试...');
      } else {
        console.log('HTTP错误:', response.status);
      }
    } catch (e) {
      console.error('异常:', e.message);
    }
  }
  
  console.log('3次失败，使用兜底');
  return getFallbackCase(trueCount, falseCount);
}

function getFallbackCase(trueCount, falseCount) {
  const cases = [
    {
      caseTitle: "画室命案", caseDescription: "画家在画室被杀。嫌疑人：助手阿明、经纪人红姐、模特小美。",
      suspects: ["阿明", "红姐", "小美"], murderer: "红姐",
      trueRules: ["阿明和红姐案发时都在画室","小美案发时在楼下被多人看到","凶器是调色刀","红姐手上有颜料痕迹","阿明和死者当天发生过争吵","小美和死者无过节","调色刀上有红姐指纹","阿明有小美的不在场证明"],
      falseRules: ["小美案发时无人看到","凶器上没有指纹"],
      reasoning: "小美有不在场证明排除。阿明和小美互相作证排除。红姐有颜料痕迹+调色刀指纹+在画室=凶手。"
    },
    {
      caseTitle: "密室中毒", caseDescription: "程序员在封闭办公室中毒身亡。嫌疑人：同事大刘、女友小杨、老板郑总。",
      suspects: ["大刘", "小杨", "郑总"], murderer: "大刘",
      trueRules: ["毒药在咖啡中，15分钟发作","大刘案发前15分钟给死者递过咖啡","小杨案发时在楼下餐厅","郑总案发时在开会","只有大刘和死者会煮咖啡","小杨有餐厅监控证明","郑总开会时有10人作证","大刘和死者最近因项目有矛盾"],
      falseRules: ["小杨案发时不在餐厅","毒药1分钟发作"],
      reasoning: "小杨和郑总都有不在场证明排除。咖啡只有大刘和死者会煮，大刘递咖啡时间与15分钟吻合，且有动机。大刘是凶手。"
    }
  ];
  const c = cases[Math.floor(Math.random() * cases.length)];
  return { ...c, trueRules: c.trueRules.slice(0, trueCount), falseRules: c.falseRules.slice(0, falseCount) };
}

function shuffleArray(arr) { const a = [...arr]; for (let i = a.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]] = [a[j],a[i]]; } return a; }

function assignRules(trueRules, falseRules, totalPlayers) {
  const shuffledTrue = shuffleArray(trueRules), shuffledFalse = shuffleArray(falseRules);
  const falseHolderIndices = shuffleArray([...Array(totalPlayers).keys()]).slice(0, shuffledFalse.length);
  const assignments = []; let trueIndex = 0, falseIndex = 0;
  for (let i = 0; i < totalPlayers; i++) {
    const playerRules = [];
    if (falseHolderIndices.includes(i) && falseIndex < shuffledFalse.length) {
      playerRules.push({ rule: shuffledFalse[falseIndex], isTrue: false }); falseIndex++;
      playerRules.push({ rule: shuffledTrue[trueIndex], isTrue: true }); trueIndex++;
    } else {
      playerRules.push({ rule: shuffledTrue[trueIndex], isTrue: true }); trueIndex++;
      playerRules.push({ rule: shuffledTrue[trueIndex], isTrue: true }); trueIndex++;
    }
    assignments.push({ playerIndex: i, playerRules, hasFalse: falseHolderIndices.includes(i) });
  }
  return assignments;
}

function getBotName(index) {
  const names = ['侦探小王', '推理达人', '逻辑怪', '福尔摩斯猫', '机智老张', '观察者小李'];
  return names[index % names.length];
}

function botSelectStatement(botRules) {
  const trueRules = botRules.filter(r => r.isTrue);
  if (trueRules.length > 0) return trueRules[Math.floor(Math.random() * trueRules.length)].rule;
  return botRules[Math.floor(Math.random() * botRules.length)].rule;
}

// ==================== 人机讨论：角色立场发言 ====================
async function generateBotDiscussionLine(botName, botRules, hasFalse, statements, suspects, caseDescription) {
  if (!API_KEY) {
    return hasFalse ? "我觉得没那么简单，再想想。" : "关键线索已经出现了，仔细看。";
  }
  
  const rulesText = botRules.map(r => `(${r.isTrue?'真':'假'})${r.rule}`).join(';');
  const statementsText = statements.map(s => `${s.nickname}:"${s.rule}"`).join(';');
  
  const prompt = `你是"${botName}"，正在玩推理游戏。
案件：${caseDescription}
嫌疑人：${suspects.join('、')}
你的规则：${rulesText}
已公开：${statementsText}
${hasFalse ? '你手中有一条假规则（你不知道是哪条）。你的立场是误导他人、保护真凶不被发现。你可以撒谎、歪曲事实、转移话题。但不要直接说"我有假规则"。' : '你手中全是真规则。你的立场是找出真凶。你要分析逻辑矛盾，但不要暴露自己具体有哪条规则。'}

用"${botName}"的口吻发表一句推理发言，≤20字，自然像真人。`;

  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'Qwen/Qwen2.5-7B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.95, max_tokens: 60 }),
      signal: c.signal
    });
    clearTimeout(t);
    const d = await r.json();
    return d.choices[0].message.content.trim();
  } catch (e) {
    return hasFalse ? "别想太多，没那么复杂。" : "这条线索很重要。";
  }
}

// ==================== 人机回复玩家提问 ====================
async function generateBotReply(botName, botRules, hasFalse, statements, suspects, caseDescription, playerMessage) {
  if (!API_KEY) return hasFalse ? "你说的有道理，但未必。" : "同意你的看法。";
  
  const rulesText = botRules.map(r => `(${r.isTrue?'真':'假'})${r.rule}`).join(';');
  const statementsText = statements.map(s => `${s.nickname}:"${s.rule}"`).join(';');
  
  const prompt = `你是"${botName}"，推理游戏中有人对你说："${playerMessage}"
案件：${caseDescription}。嫌疑人：${suspects.join('、')}
你的规则：${rulesText}。已公开：${statementsText}
${hasFalse ? '你有假规则，立场是误导。你可以撒谎、否认、转移话题。' : '你全是真规则，立场是推理。你要根据线索回应。'}
回复≤15字，用"${botName}"的口吻。`;

  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'Qwen/Qwen2.5-7B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 50 }),
      signal: c.signal
    });
    clearTimeout(t);
    const d = await r.json();
    return d.choices[0].message.content.trim();
  } catch (e) {
    return hasFalse ? "不一定，再想想。" : "我同意。";
  }
}

function botMakeAccusation(botRules, players, falseHolderCandidates, suspects) {
  let guessedFalsePlayer;
  if (Math.random() < 0.5 && falseHolderCandidates.length > 0) {
    guessedFalsePlayer = falseHolderCandidates[Math.floor(Math.random() * falseHolderCandidates.length)];
  } else {
    const others = players.filter(p => p.id !== 'self');
    guessedFalsePlayer = others.length > 0 ? others[Math.floor(Math.random() * others.length)].id : players[0]?.id;
  }
  return { falsePlayerId: guessedFalsePlayer, murdererGuess: suspects[Math.floor(Math.random() * suspects.length)] };
}

// ==================== Socket ====================
io.on('connection', (socket) => {
  console.log('连接:', socket.id);

  socket.on('joinRoom', ({ nickname, roomId }) => {
    if (!nickname) return;
    const targetRoomId = roomId || generateRoomId();
    if (!rooms.has(targetRoomId)) {
      rooms.set(targetRoomId, {
        players: new Map(), bots: new Map(), host: socket.id, phase: 'lobby',
        caseData: null, playerAssignments: [], botAssignments: [],
        statements: [], accusations: [], discussReady: new Set(), botTimers: [],
        totalPlayers: 0, statementSubmitted: new Set()
      });
    }
    const room = rooms.get(targetRoomId);
    room.players.set(socket.id, { nickname, isBot: false });
    socket.join(targetRoomId);
    socket.emit('roomJoined', { roomId: targetRoomId, playerId: socket.id, players: getPlayersList(room), phase: room.phase, isHost: room.host === socket.id });
    io.to(targetRoomId).emit('playerListUpdate', getPlayersList(room));
  });

  socket.on('addBots', ({ roomId, count }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    for (let i = 0; i < count; i++) {
      room.bots.set(generateBotId(), { nickname: getBotName(room.bots.size + i), isBot: true });
    }
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
  });

  socket.on('removeBots', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    room.bots.clear();
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
  });

  socket.on('startGame', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    const totalPlayers = room.players.size + room.bots.size;
    if (totalPlayers < 2) { socket.emit('errorMessage', '至少2人'); return; }
    room.totalPlayers = totalPlayers;
    room.phase = 'preparing';
    room.statementSubmitted = new Set();
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: 'AI生成案件中...' });
    
    const caseData = await generateCase(totalPlayers);
    room.caseData = caseData;
    const assignments = assignRules(caseData.trueRules, caseData.falseRules, totalPlayers);
    const playerIds = Array.from(room.players.keys());
    room.playerAssignments = [];
    for (let i = 0; i < playerIds.length; i++) room.playerAssignments.push({ playerId: playerIds[i], rules: assignments[i].playerRules, hasFalse: assignments[i].hasFalse });
    const botIds = Array.from(room.bots.keys());
    room.botAssignments = [];
    for (let i = 0; i < botIds.length; i++) room.botAssignments.push({ botId: botIds[i], rules: assignments[playerIds.length + i].playerRules, hasFalse: assignments[playerIds.length + i].hasFalse });
    
    room.phase = 'reading'; room.statements = []; room.accusations = []; room.discussReady = new Set();
    io.to(roomId).emit('phaseChange', { phase: 'reading', message: '查看规则', totalPlayers });
    for (const a of room.playerAssignments) {
      const ps = io.sockets.sockets.get(a.playerId);
      if (ps) ps.emit('yourRules', { rules: a.rules, hasFalseRule: a.hasFalse, caseTitle: caseData.caseTitle, caseDescription: caseData.caseDescription, suspects: caseData.suspects });
    }
    room.botAssignments.forEach((a) => {
      const timer = setTimeout(() => {
        if (room.phase === 'reading') {
          room.discussReady.add(a.botId);
          io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: totalPlayers });
          if (room.discussReady.size === totalPlayers) {
            room.phase = 'statement'; room.discussReady.clear(); room.statements = []; room.statementSubmitted = new Set();
            io.to(roomId).emit('phaseChange', { phase: 'statement', message: '陈述阶段', totalPlayers });
            startBotStatements(room, roomId);
          }
        }
      }, 2000 + Math.random() * 3000);
      room.botTimers.push(timer);
    });
  });

  function startBotStatements(room, roomId) {
    room.botAssignments.forEach((a) => {
      const timer = setTimeout(() => {
        if (room.phase === 'statement') {
          const rule = botSelectStatement(a.rules);
          const botInfo = room.bots.get(a.botId);
          room.statements.push({ playerId: a.botId, nickname: botInfo.nickname, rule });
          room.statementSubmitted.add(a.botId);
          io.to(roomId).emit('statementSubmitProgress', { submitted: room.statementSubmitted.size, total: room.totalPlayers });
          if (room.statementSubmitted.size === room.totalPlayers) revealStatements(room, roomId);
        }
      }, 3000 + Math.random() * 4000);
      room.botTimers.push(timer);
    });
  }

  function revealStatements(room, roomId) {
    io.to(roomId).emit('statementsRevealed', room.statements);
    setTimeout(() => {
      room.phase = 'discuss'; room.discussReady.clear();
      io.to(roomId).emit('phaseChange', { phase: 'discuss', message: '讨论', statements: room.statements, suspectList: room.caseData.suspects, totalPlayers: room.totalPlayers });
      startBotDiscussion(room, roomId);
      setTimeout(() => { if (room.phase === 'discuss') io.to(roomId).emit('discussTimeout'); }, MAX_DISCUSS_TIME);
    }, 2000);
  }

  function startBotDiscussion(room, roomId) {
    room.botAssignments.forEach((a) => {
      const count = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) {
        const timer = setTimeout(async () => {
          if (room.phase === 'discuss') {
            const botInfo = room.bots.get(a.botId);
            const line = await generateBotDiscussionLine(botInfo.nickname, a.rules, a.hasFalse, room.statements, room.caseData.suspects, room.caseData.caseDescription);
            io.to(roomId).emit('chatMessage', { from: botInfo.nickname, message: line });
          }
        }, 8000 + i * 15000 + Math.random() * 8000);
        room.botTimers.push(timer);
      }
    });
  }

  function startBotReadyToAccusation(room, roomId) {
    room.botAssignments.forEach((a) => {
      const timer = setTimeout(() => {
        if (room.phase === 'discuss') {
          room.discussReady.add(a.botId);
          io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
          if (room.discussReady.size === room.totalPlayers) startAccusationPhase(room, roomId);
        }
      }, 3000 + Math.random() * 5000);
      room.botTimers.push(timer);
    });
  }

  function clearBotTimers(room) { room.botTimers.forEach(t => clearTimeout(t)); room.botTimers = []; }

  socket.on('chatMessage', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'discuss') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    io.to(roomId).emit('chatMessage', { from: player.nickname, message });
    
    room.bots.forEach(async (botInfo, botId) => {
      if (message.includes(botInfo.nickname)) {
        const ba = room.botAssignments.find(a => a.botId === botId);
        if (!ba) return;
        setTimeout(async () => {
          if (room.phase === 'discuss') {
            const reply = await generateBotReply(botInfo.nickname, ba.rules, ba.hasFalse, room.statements, room.caseData.suspects, room.caseData.caseDescription, message);
            io.to(roomId).emit('chatMessage', { from: botInfo.nickname, message: reply });
          }
        }, 2000 + Math.random() * 3000);
      }
    });
  });

  socket.on('readyToStatement', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'reading') return;
    room.discussReady.add(socket.id);
    io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
    if (room.discussReady.size === room.totalPlayers) {
      room.phase = 'statement'; room.discussReady.clear(); room.statements = []; room.statementSubmitted = new Set();
      io.to(roomId).emit('phaseChange', { phase: 'statement', message: '陈述阶段', totalPlayers: room.totalPlayers });
      startBotStatements(room, roomId);
    }
  });

  socket.on('submitStatement', ({ roomId, rule }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'statement') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.statements.push({ playerId: socket.id, nickname: player.nickname, rule });
    room.statementSubmitted.add(socket.id);
    io.to(roomId).emit('statementSubmitProgress', { submitted: room.statementSubmitted.size, total: room.totalPlayers });
    if (room.statementSubmitted.size === room.totalPlayers) revealStatements(room, roomId);
  });

  socket.on('readyToAccusation', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'discuss') return;
    room.discussReady.add(socket.id);
    io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
    if (room.discussReady.size === 1) startBotReadyToAccusation(room, roomId);
    if (room.discussReady.size === room.totalPlayers) startAccusationPhase(room, roomId);
  });

  socket.on('forceAccusation', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.phase !== 'discuss') return;
    clearBotTimers(room);
    startAccusationPhase(room, roomId);
  });

  function startAccusationPhase(room, roomId) {
    clearBotTimers(room);
    room.phase = 'accusation'; room.accusations = [];
    io.to(roomId).emit('phaseChange', { phase: 'accusation', message: '指控', players: getPlayersList(room), suspectList: room.caseData.suspects, totalPlayers: room.totalPlayers });
    startBotAccusations(room, roomId);
  }

  function startBotAccusations(room, roomId) {
    const allPlayers = getPlayersList(room);
    const falseIds = room.botAssignments.filter(a => a.hasFalse).map(a => a.botId).concat(room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId));
    room.botAssignments.forEach((a) => {
      const timer = setTimeout(() => {
        if (room.phase === 'accusation') {
          const { falsePlayerId, murdererGuess } = botMakeAccusation(a.rules, allPlayers.filter(p => p.id !== a.botId), falseIds.filter(id => id !== a.botId), room.caseData.suspects);
          room.accusations.push({ playerId: a.botId, nickname: room.bots.get(a.botId).nickname, falsePlayerId, murdererGuess, isBot: true });
          io.to(roomId).emit('accusationUpdate', { submitted: room.accusations.length, total: room.totalPlayers });
          if (room.accusations.length === room.totalPlayers) revealAccusations(room, roomId);
        }
      }, 2000 + Math.random() * 3000);
      room.botTimers.push(timer);
    });
  }

  function revealAccusations(room, roomId) {
    const fv = {}, mv = {};
    room.accusations.forEach(a => {
      const n = (room.players.get(a.falsePlayerId) || room.bots.get(a.falsePlayerId))?.nickname || '?';
      fv[n] = (fv[n] || 0) + 1; mv[a.murdererGuess] = (mv[a.murdererGuess] || 0) + 1;
    });
    const maj = Math.floor(room.totalPlayers / 2) + 1;
    io.to(roomId).emit('accusationsRevealed', { falseVotes: fv, murdererVotes: mv, totalPlayers: room.totalPlayers, majority: maj });
    setTimeout(() => calcResults(room, roomId, fv, mv, maj), 3000);
  }

  socket.on('submitAccusation', ({ roomId, falsePlayerId, murdererGuess }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'accusation') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.accusations.push({ playerId: socket.id, nickname: player.nickname, falsePlayerId, murdererGuess, isBot: false });
    io.to(roomId).emit('accusationUpdate', { submitted: room.accusations.length, total: room.totalPlayers });
    if (room.accusations.length === room.totalPlayers) revealAccusations(room, roomId);
  });

  function calcResults(room, roomId, fv, mv, maj) {
    clearBotTimers(room);
    const realM = room.caseData.murderer;
    const falseHolders = room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId).concat(room.botAssignments.filter(a => a.hasFalse).map(a => a.botId));
    const correctFH = falseHolders.map(id => (room.players.get(id) || room.bots.get(id))?.nickname).filter(Boolean);
    const topF = Object.entries(fv).sort((a,b) => b[1]-a[1])[0]?.[0];
    const topM = Object.entries(mv).sort((a,b) => b[1]-a[1])[0]?.[0];
    const fOk = correctFH.includes(topF) && (fv[topF]||0) >= maj;
    const mOk = topM === realM && (mv[topM]||0) >= maj;
    let gs = 0, bs = 0;
    if (fOk) gs++; else bs++;
    if (mOk) gs++; else bs++;
    
    const vd = room.accusations.map(a => ({
      nickname: a.nickname, votedFalsePlayer: (room.players.get(a.falsePlayerId) || room.bots.get(a.falsePlayerId))?.nickname || '?',
      votedMurderer: a.murdererGuess, isBot: a.isBot || false
    }));
    const apr = [];
    room.playerAssignments.forEach(a => { const p = room.players.get(a.playerId); apr.push({ nickname: p?.nickname||'?', hasFalse: a.hasFalse, rules: a.rules.map(r=>({rule:r.rule,isTrue:r.isTrue})) }); });
    room.botAssignments.forEach(a => { const b = room.bots.get(a.botId); apr.push({ nickname: b?.nickname||'?', hasFalse: a.hasFalse, rules: a.rules.map(r=>({rule:r.rule,isTrue:r.isTrue})) }); });
    
    room.phase = 'result';
    io.to(roomId).emit('gameResult', {
      falseHolders: correctFH, realMurderer: realM, goodScore: gs, badScore: bs,
      winner: gs >= bs ? '正方（推理者）' : '反方（扰乱者）',
      reasoning: room.caseData.reasoning, caseTitle: room.caseData.caseTitle,
      allPlayerRules: apr, falseVotes: fv, murdererVotes: mv, majority: maj,
      mostVotedFalse: topF, mostVotedMurderer: topM, falseCorrect: fOk, murdererCorrect: mOk,
      voteDetails: vd
    });
  }

  socket.on('leaveRoom', ({ roomId }) => handleLeave(socket, roomId));
  socket.on('disconnect', () => {
    for (const [rid, room] of rooms.entries()) {
      if (room.players.has(socket.id)) { handleLeave(socket, rid); break; }
    }
  });

  function handleLeave(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    clearBotTimers(room);
    room.players.delete(socket.id);
    room.discussReady.delete(socket.id);
    socket.leave(roomId);
    if (room.players.size === 0) { rooms.delete(roomId); return; }
    if (room.host === socket.id) room.host = room.players.keys().next().value;
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n✅ 端口 ${PORT}`));

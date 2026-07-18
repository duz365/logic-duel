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

const presetCases = [
  {
    caseTitle: "博物馆失窃案",
    caseDescription: "深夜，市博物馆的名画《星空下的猫》被盗。嫌疑人：保安张三、清洁工李四、馆长王五。",
    suspects: ["保安张三", "清洁工李四", "馆长王五"],
    murderer: "清洁工李四",
    trueRules: [
      "监控显示案发时间有两人进入过展厅","保安张三和馆长王五在案发时间在一起喝酒",
      "小偷身高不超过175cm","清洁工李四身高170cm","馆长王五身高182cm",
      "保安张三身高178cm","展厅窗户从内部锁着","清洁工李四有展厅备用钥匙"
    ],
    falseRules: ["监控显示案发时间只有一人进入过展厅","清洁工李四案发时已下班"],
    reasoning: "两人进入展厅，排除单人作案。张三和王五一起喝酒互相作证。小偷≤175cm，王五182cm、张三178cm不符合，李四170cm符合。窗内锁+备用钥匙指向李四。"
  },
  {
    caseTitle: "毒杀晚宴",
    caseDescription: "富豪王某在晚宴中毒身亡。嫌疑人：王太太、老张、陈医生。",
    suspects: ["王太太", "老张", "陈医生"],
    murderer: "王太太",
    trueRules: [
      "毒药在红酒中，5分钟发作","王太太案发前10分钟给王某倒酒",
      "老张案发前3分钟与王某碰杯","陈医生案发前8分钟给王某递药",
      "毒药遇水变蓝","王某酒杯内壁有蓝色残留",
      "陈医生的药是胶囊不接触酒杯","老张和王某喝同一瓶酒，老张没事"
    ],
    falseRules: ["毒药1分钟内发作","陈医生的药遇水变蓝"],
    reasoning: "毒5分钟发作+酒杯蓝残留=毒在酒中。陈医生胶囊不接触酒杯，排除。老张同瓶酒没事，排除。王太太倒酒时机吻合10分钟前。"
  },
  {
    caseTitle: "坠楼疑云",
    caseDescription: "李某从18楼坠亡。嫌疑人：赵总、小周、孙小姐。",
    suspects: ["赵总", "小周", "孙小姐"],
    murderer: "赵总",
    trueRules: [
      "李某坠楼前收到'来天台'短信","赵总手机案发时给李某发过短信",
      "天台监控案发当天被人为关闭","孙小姐案发时在医院陪护",
      "小周和赵总案发后互相指认","李某指甲有赵总DNA",
      "赵总手腕有新鲜抓痕","李某桌内有举报赵总贪污的信"
    ],
    falseRules: ["天台监控当天正常工作","孙小姐案发时出现在公司"],
    reasoning: "DNA+抓痕=肢体冲突。短信+关监控=预谋。孙小姐有不在场证明。举报信=动机。赵总是凶手。"
  }
];

const recentCases = [];

function getRandomPresetCase(trueCount, falseCount) {
  const suitable = presetCases.filter(c => 
    c.trueRules.length >= trueCount && 
    c.falseRules.length >= falseCount &&
    !recentCases.includes(c.caseTitle)
  );
  const pool = suitable.length > 0 ? suitable : presetCases;
  if (suitable.length === 0) recentCases.length = 0;
  const selected = pool[Math.floor(Math.random() * pool.length)];
  recentCases.push(selected.caseTitle);
  if (recentCases.length > 10) recentCases.shift();
  return {
    caseTitle: selected.caseTitle,
    caseDescription: selected.caseDescription,
    suspects: selected.suspects,
    murderer: selected.murderer,
    trueRules: selected.trueRules.slice(0, trueCount),
    falseRules: selected.falseRules.slice(0, falseCount),
    reasoning: selected.reasoning
  };
}

async function generateCase(playerCount) {
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`\n===== 生成案件 ===== 玩家:${playerCount} 真:${trueCount} 假:${falseCount}`);
  
  if (API_KEY) {
    console.log('AI生成中...');
    const prompt = `生成推理案件。输出纯JSON。

硬性要求：
- 3个嫌疑人，每人至少在规则中出现2次
- 严格${trueCount}条真规则，${falseCount}条假规则
- 每条规则≤20字，简洁陈述句
- 真规则合起来唯一指向凶手，缺一不可
- 假规则与真规则逻辑矛盾但不是直接否定
- 不要"监控坏了""不在场证明"套路

{"caseTitle":"≤8字","caseDescription":"≤40字","suspects":["名1","名2","名3"],"murderer":"凶手名","trueRules":["规则"...共${trueCount}条],"falseRules":["规则"...共${falseCount}条],"reasoning":"≤80字"}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.85, max_tokens: 1500 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) {
        const data = await response.json();
        let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const p = JSON.parse(content);
        if (p.caseTitle && p.murderer && p.trueRules?.length >= trueCount && p.falseRules?.length >= falseCount) {
          console.log('✅', p.caseTitle, '| 凶手:', p.murderer);
          return {
            caseTitle: p.caseTitle, caseDescription: p.caseDescription || '',
            suspects: p.suspects, murderer: p.murderer,
            trueRules: p.trueRules.slice(0, trueCount),
            falseRules: p.falseRules.slice(0, falseCount),
            reasoning: p.reasoning || ''
          };
        }
      }
    } catch (e) { console.error('AI异常:', e.message); }
  }
  console.log('使用预设');
  return getRandomPresetCase(trueCount, falseCount);
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

const botShortLines = {
  honest: [
    "两人进过展厅，排除单人作案。","身高那条很关键。","内部锁窗+钥匙，指向内部人员。",
    "时间线对不上。","不在场证明互相矛盾。","关键证据指向同一个人。"
  ],
  misleading: [
    "我觉得没那么复杂。","时间线可能有误。","有些规则未必是真的。","方向是不是偏了？"
  ]
};

function getBotShortLine(isFalseHolder) {
  const pool = isFalseHolder ? botShortLines.misleading : botShortLines.honest;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function generateBotReply(botName, botRules, hasFalse, statements, suspects, caseDescription, playerMessage) {
  if (!API_KEY) return hasFalse ? "有道理，但未必。" : "同意。";
  const rulesText = botRules.map(r => `(${r.isTrue?'真':'假'})${r.rule}`).join(';');
  const statementsText = statements.map(s => `${s.nickname}:"${s.rule}"`).join(';');
  const prompt = `推理游戏。案件:${caseDescription}。嫌疑人:${suspects.join(',')}。你的规则:${rulesText}。已公开:${statementsText}。${hasFalse?'你有假规则但不知哪条，需误导。':''}玩家说:"${playerMessage}"。回复≤15字，简洁。`;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'Qwen/Qwen2.5-7B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.8, max_tokens: 40 }),
      signal: c.signal
    });
    clearTimeout(t);
    const d = await r.json();
    return d.choices[0].message.content.trim();
  } catch (e) { return hasFalse ? "有道理，但未必。" : "同意。"; }
}

function botMakeAccusation(botRules, players, falseHolderCandidates, suspects) {
  let guessedFalsePlayer;
  if (Math.random() < 0.55 && falseHolderCandidates.length > 0) {
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
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: '生成案件...' });
    
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
        const timer = setTimeout(() => {
          if (room.phase === 'discuss') {
            io.to(roomId).emit('chatMessage', { from: room.bots.get(a.botId).nickname, message: getBotShortLine(a.hasFalse) });
          }
        }, 8000 + i * 12000 + Math.random() * 6000);
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

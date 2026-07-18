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
const API_TIMEOUT = 15000;

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
    caseDescription: "深夜，市博物馆的名画《星空下的猫》被盗。现场有三个嫌疑人：保安张三、清洁工李四、馆长王五。",
    suspects: ["保安张三", "清洁工李四", "馆长王五"],
    murderer: "清洁工李四",
    trueRules: [
      "监控显示案发时间有两人进入过展厅","保安张三和馆长王五在案发时间在一起喝酒",
      "小偷身高不超过175cm","清洁工李四身高170cm","馆长王五身高182cm",
      "保安张三身高178cm","展厅窗户从内部锁着，没有被撬痕迹","清洁工李四有展厅的备用钥匙"
    ],
    falseRules: ["监控显示案发时间只有一人进入过展厅","清洁工李四在案发时间已经下班回家"],
    reasoning: "监控显示两人进入展厅，排除单独作案。张三和王五一起喝酒互相作证，两人排除。小偷身高≤175cm，王五182cm、张三178cm不符合，只有李四170cm符合。窗户内部锁着说明是内部人员作案，李四有备用钥匙。因此李四是小偷。"
  },
  {
    caseTitle: "毒杀晚宴",
    caseDescription: "富豪王某在家中举办晚宴时中毒身亡。当晚只有三个人接触过他的酒杯：他的妻子王太太、商业伙伴老张、私人医生陈医生。",
    suspects: ["王太太", "老张", "陈医生"],
    murderer: "王太太",
    trueRules: [
      "毒药在红酒中，需要5分钟才会发作","王太太在案发前10分钟给王某倒过酒",
      "老张在案发前3分钟和王某碰过杯","陈医生在案发前8分钟给王某递过药",
      "毒药遇到水会变成蓝色","王某的酒杯内壁有蓝色残留",
      "陈医生的药是胶囊，不接触酒杯","老张和王某喝的是同一瓶酒，老张没事"
    ],
    falseRules: ["毒药是速效的，1分钟内发作","陈医生的药和水接触后会变蓝"],
    reasoning: "毒药5分钟发作+酒杯有蓝色残留=毒在酒里且接触了水。陈医生给的是胶囊不接触酒杯，排除。老张和王某喝同一瓶酒却没事，说明毒不在酒瓶里，排除老张。王太太倒酒时最有机会下毒，且10分钟前倒酒符合5分钟发作时间线。因此王太太是凶手。"
  },
  {
    caseTitle: "坠楼疑云",
    caseDescription: "某公司员工李某从18楼坠亡。警方锁定三名嫌疑人：他的上司赵总、同事小周、以及前女友孙小姐。",
    suspects: ["赵总", "小周", "孙小姐"],
    murderer: "赵总",
    trueRules: [
      "李某坠楼前收到一条短信，内容是'来天台'","赵总的手机在案发时间给李某发过短信",
      "天台的监控在案发当天被人为关闭","孙小姐在案发时有不在场证明，她在医院陪护",
      "小周和赵总在案发后互相指认对方","李某的指甲里有皮肤组织，DNA属于赵总",
      "赵总的手腕上有新鲜的抓痕","李某的办公桌里有一封举报赵总贪污的信"
    ],
    falseRules: ["天台监控在案发当天正常工作","孙小姐在案发时出现在公司大楼"],
    reasoning: "指甲DNA+手腕抓痕=李某和赵总有过肢体冲突。发短信约天台+关监控=预谋。孙小姐有不在场证明，排除。小周和赵总互相指认，但物理证据指向赵总。举报信提供了动机。因此赵总是凶手。"
  }
];

async function generateCase(playerCount) {
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  const suitable = presetCases.filter(c => c.trueRules.length >= trueCount && c.falseRules.length >= falseCount);
  if (suitable.length > 0) {
    const s = suitable[Math.floor(Math.random() * suitable.length)];
    return { caseTitle: s.caseTitle, caseDescription: s.caseDescription, suspects: s.suspects, murderer: s.murderer, trueRules: s.trueRules.slice(0, trueCount), falseRules: s.falseRules.slice(0, falseCount), reasoning: s.reasoning };
  }
  if (!API_KEY) return getDefaultCase();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
    const response = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `生成推理案件。输出纯JSON。${trueCount}条真规则，${falseCount}条假规则。格式：{"caseTitle":"","caseDescription":"","suspects":[],"murderer":"","trueRules":[],"falseRules":[],"reasoning":""}` }], temperature: 0.6, max_tokens: 1500 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(content);
  } catch (e) { return getDefaultCase(); }
}

function getDefaultCase() {
  return { caseTitle: "博物馆失窃案", caseDescription: "深夜，市博物馆的名画被盗。", suspects: ["保安张三", "清洁工李四", "馆长王五"], murderer: "清洁工李四", trueRules: ["监控显示案发时间有两人进入过展厅","保安张三和馆长王五在案发时间在一起喝酒","小偷身高不超过175cm","清洁工李四身高170cm","馆长王五身高182cm","保安张三身高178cm"], falseRules: ["监控显示案发时间只有一人进入过展厅"], reasoning: "监控显示两人进入展厅，排除单独作案。张三和王五一起喝酒互相作证，两人排除。小偷身高≤175cm，王五182cm、张三178cm不符合，只有李四170cm符合。" };
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

async function generateBotDiscussion(botName, botRules, hasFalse, statements, suspects, caseDescription) {
  if (!API_KEY) {
    const lines = hasFalse ? 
      ["我觉得大家都想多了，可能就是最简单的答案。","我建议重新看看每条规则，说不定有遗漏。"] :
      ["我们需要仔细对比一下公开的规则，看看有没有矛盾。","按目前公开的规则来看，让我再想想。"];
    return lines[Math.floor(Math.random() * lines.length)];
  }
  
  const rulesText = botRules.map(r => `(${r.isTrue?'真规则':'假规则'})${r.rule}`).join('; ');
  const statementsText = statements.map(s => `${s.nickname}: "${s.rule}"`).join('; ');
  
  const prompt = `你在玩一个推理游戏。案件：${caseDescription}。嫌疑人：${suspects.join('、')}。

你持有的规则：${rulesText}
已公开的规则：${statementsText}
${hasFalse ? '注意：你持有的规则中有一条是假的，但你不知道是哪一条。你需要在讨论中引导大家走向错误的方向，但不要暴露自己。' : '你的规则都是真的。你需要帮助大家找出逻辑矛盾。'}

请用中文发表一段简短的推理发言（20-40字），不要说"根据我的规则"这种暴露身份的话。`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'Qwen/Qwen2.5-7B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 100 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (e) {
    return hasFalse ? "我觉得方向可能偏了，大家再想想。" : "我们需要仔细分析每条规则。";
  }
}

function botMakeAccusation(botRules, players, falseHolderCandidates, suspects) {
  const accuracy = 0.6;
  let guessedFalsePlayer;
  if (Math.random() < accuracy && falseHolderCandidates.length > 0) {
    guessedFalsePlayer = falseHolderCandidates[Math.floor(Math.random() * falseHolderCandidates.length)];
  } else {
    const others = players.filter(p => p.id !== 'self');
    guessedFalsePlayer = others.length > 0 ? others[Math.floor(Math.random() * others.length)].id : players[0]?.id;
  }
  const murdererGuess = suspects[Math.floor(Math.random() * suspects.length)];
  return { falsePlayerId: guessedFalsePlayer, murdererGuess };
}

// ==================== Socket ====================
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);

  socket.on('joinRoom', ({ nickname, roomId }) => {
    if (!nickname) return;
    const targetRoomId = roomId || generateRoomId();
    if (!rooms.has(targetRoomId)) {
      rooms.set(targetRoomId, {
        players: new Map(), bots: new Map(), host: socket.id, phase: 'lobby',
        caseData: null, playerAssignments: [], botAssignments: [],
        statements: [], accusations: [], discussReady: new Set(), botTimers: [],
        totalPlayers: 0, statementSubmitted: new Set(),
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
    const current = room.bots.size;
    for (let i = 0; i < count; i++) {
      const botId = generateBotId();
      room.bots.set(botId, { nickname: getBotName(current + i), isBot: true });
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
    if (totalPlayers < 2) { socket.emit('errorMessage', '至少需要2名玩家'); return; }
    room.totalPlayers = totalPlayers;
    room.phase = 'preparing';
    room.statementSubmitted = new Set();
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: '正在准备案件...' });
    const caseData = await generateCase(totalPlayers);
    room.caseData = caseData;
    const assignments = assignRules(caseData.trueRules, caseData.falseRules, totalPlayers);
    const playerIds = Array.from(room.players.keys());
    room.playerAssignments = [];
    for (let i = 0; i < playerIds.length; i++) {
      room.playerAssignments.push({ playerId: playerIds[i], rules: assignments[i].playerRules, hasFalse: assignments[i].hasFalse });
    }
    const botIds = Array.from(room.bots.keys());
    room.botAssignments = [];
    for (let i = 0; i < botIds.length; i++) {
      room.botAssignments.push({ botId: botIds[i], rules: assignments[playerIds.length + i].playerRules, hasFalse: assignments[playerIds.length + i].hasFalse });
    }
    room.phase = 'reading';
    room.statements = [];
    room.accusations = [];
    room.discussReady = new Set();
    io.to(roomId).emit('phaseChange', { phase: 'reading', message: '请查看你的规则手册', totalPlayers });
    for (const a of room.playerAssignments) {
      const ps = io.sockets.sockets.get(a.playerId);
      if (ps) ps.emit('yourRules', { rules: a.rules, hasFalseRule: a.hasFalse, caseTitle: caseData.caseTitle, caseDescription: caseData.caseDescription, suspects: caseData.suspects });
    }
    room.botAssignments.forEach((a) => {
      const delay = 2000 + Math.random() * 3000;
      const timer = setTimeout(() => {
        if (room.phase === 'reading') {
          room.discussReady.add(a.botId);
          io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: totalPlayers });
          if (room.discussReady.size === totalPlayers) {
            room.phase = 'statement';
            room.discussReady.clear();
            room.statements = [];
            room.statementSubmitted = new Set();
            io.to(roomId).emit('phaseChange', { phase: 'statement', message: '陈述阶段：每人选择一条规则提交，所有人提交后统一公布', totalPlayers });
            startBotStatements(room, roomId);
          }
        }
      }, delay);
      room.botTimers.push(timer);
    });
  });

  function startBotStatements(room, roomId) {
    room.botAssignments.forEach((a) => {
      const delay = 3000 + Math.random() * 4000;
      const timer = setTimeout(() => {
        if (room.phase === 'statement') {
          const rule = botSelectStatement(a.rules);
          const botInfo = room.bots.get(a.botId);
          room.statements.push({ playerId: a.botId, nickname: botInfo.nickname, rule });
          room.statementSubmitted.add(a.botId);
          io.to(roomId).emit('statementSubmitProgress', { submitted: room.statementSubmitted.size, total: room.totalPlayers });
          if (room.statementSubmitted.size === room.totalPlayers) revealStatements(room, roomId);
        }
      }, delay);
      room.botTimers.push(timer);
    });
  }

  function revealStatements(room, roomId) {
    io.to(roomId).emit('statementsRevealed', room.statements);
    setTimeout(() => {
      room.phase = 'discuss';
      room.discussReady.clear();
      io.to(roomId).emit('phaseChange', { phase: 'discuss', message: '讨论阶段', statements: room.statements, suspectList: room.caseData.suspects, totalPlayers: room.totalPlayers });
      startBotDiscussion(room, roomId);
      setTimeout(() => { if (room.phase === 'discuss') io.to(roomId).emit('discussTimeout'); }, MAX_DISCUSS_TIME);
    }, 2000);
  }

  async function startBotDiscussion(room, roomId) {
    for (const a of room.botAssignments) {
      const msgCount = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < msgCount; i++) {
        const delay = 5000 + i * 10000 + Math.random() * 5000;
        const timer = setTimeout(async () => {
          if (room.phase === 'discuss') {
            const botInfo = room.bots.get(a.botId);
            const line = await generateBotDiscussion(botInfo.nickname, a.rules, a.hasFalse, room.statements, room.caseData.suspects, room.caseData.caseDescription);
            io.to(roomId).emit('chatMessage', { from: botInfo.nickname, message: line });
          }
        }, delay);
        room.botTimers.push(timer);
      }
    }
  }

  function startBotReadyToAccusation(room, roomId) {
    room.botAssignments.forEach((a) => {
      const delay = 3000 + Math.random() * 5000;
      const timer = setTimeout(() => {
        if (room.phase === 'discuss') {
          room.discussReady.add(a.botId);
          io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
          if (room.discussReady.size === room.totalPlayers) startAccusationPhase(room, roomId);
        }
      }, delay);
      room.botTimers.push(timer);
    });
  }

  function clearBotTimers(room) { room.botTimers.forEach(t => clearTimeout(t)); room.botTimers = []; }

  socket.on('readyToStatement', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'reading') return;
    room.discussReady.add(socket.id);
    io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
    if (room.discussReady.size === room.totalPlayers) {
      room.phase = 'statement';
      room.discussReady.clear();
      room.statements = [];
      room.statementSubmitted = new Set();
      io.to(roomId).emit('phaseChange', { phase: 'statement', message: '陈述阶段：每人选择一条规则提交，所有人提交后统一公布', totalPlayers: room.totalPlayers });
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

  socket.on('chatMessage', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'discuss') return;
    const player = room.players.get(socket.id);
    if (player) io.to(roomId).emit('chatMessage', { from: player.nickname, message });
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
    room.phase = 'accusation';
    room.accusations = [];
    io.to(roomId).emit('phaseChange', { phase: 'accusation', message: '指控阶段', players: getPlayersList(room), suspectList: room.caseData.suspects, totalPlayers: room.totalPlayers });
    startBotAccusations(room, roomId);
  }

  function startBotAccusations(room, roomId) {
    const allPlayers = getPlayersList(room);
    const falseHolderIds = room.botAssignments.filter(a => a.hasFalse).map(a => a.botId).concat(room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId));
    room.botAssignments.forEach((a) => {
      const delay = 2000 + Math.random() * 3000;
      const timer = setTimeout(() => {
        if (room.phase === 'accusation') {
          const botInfo = room.bots.get(a.botId);
          const { falsePlayerId, murdererGuess } = botMakeAccusation(a.rules, allPlayers.filter(p => p.id !== a.botId), falseHolderIds.filter(id => id !== a.botId), room.caseData.suspects);
          room.accusations.push({ playerId: a.botId, nickname: botInfo.nickname, falsePlayerId, murdererGuess, isBot: true });
          io.to(roomId).emit('accusationUpdate', { submitted: room.accusations.length, total: room.totalPlayers });
          if (room.accusations.length === room.totalPlayers) revealAccusations(room, roomId);
        }
      }, delay);
      room.botTimers.push(timer);
    });
  }

  function revealAccusations(room, roomId) {
    const falseVotes = {}, murdererVotes = {};
    room.accusations.forEach(a => {
      const fpName = (room.players.get(a.falsePlayerId) || room.bots.get(a.falsePlayerId))?.nickname || '未知';
      falseVotes[fpName] = (falseVotes[fpName] || 0) + 1;
      murdererVotes[a.murdererGuess] = (murdererVotes[a.murdererGuess] || 0) + 1;
    });
    const majority = Math.floor(room.totalPlayers / 2) + 1;
    io.to(roomId).emit('accusationsRevealed', { falseVotes, murdererVotes, totalPlayers: room.totalPlayers, majority });
    setTimeout(() => calculateResults(room, roomId, falseVotes, murdererVotes, majority), 3000);
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

  function calculateResults(room, roomId, falseVotes, murdererVotes, majority) {
    clearBotTimers(room);
    const caseData = room.caseData;
    const realMurderer = caseData.murderer;
    const falseHolders = room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId).concat(room.botAssignments.filter(a => a.hasFalse).map(a => a.botId));
    
    const results = [];
    let goodScore = 0, badScore = 0;
    
    // 用投票结果判定：假规则持有者投票是否过半数正确，凶手投票是否过半数正确
    const correctFalseHolder = falseHolders.map(id => (room.players.get(id) || room.bots.get(id))?.nickname).filter(Boolean);
    const mostVotedFalse = Object.entries(falseVotes).sort((a,b) => b[1]-a[1])[0]?.[0];
    const mostVotedMurderer = Object.entries(murdererVotes).sort((a,b) => b[1]-a[1])[0]?.[0];
    
    const falseVoteCount = falseVotes[mostVotedFalse] || 0;
    const murdererVoteCount = murdererVotes[mostVotedMurderer] || 0;
    
    const falseCorrect = correctFalseHolder.includes(mostVotedFalse) && falseVoteCount >= majority;
    const murdererCorrect = mostVotedMurderer === realMurderer && murdererVoteCount >= majority;
    
    if (falseCorrect) goodScore++; else badScore++;
    if (murdererCorrect) goodScore++; else badScore++;
    
    // 每个玩家的详细投票
    const voteDetails = room.accusations.map(a => ({
      nickname: a.nickname,
      votedFalsePlayer: (room.players.get(a.falsePlayerId) || room.bots.get(a.falsePlayerId))?.nickname || '未知',
      votedMurderer: a.murdererGuess,
      isBot: a.isBot || false
    }));
    
    const allPlayerRules = [];
    room.playerAssignments.forEach(a => {
      const p = room.players.get(a.playerId);
      allPlayerRules.push({ nickname: p?.nickname || '未知', hasFalse: a.hasFalse, rules: a.rules.map(r => ({ rule: r.rule, isTrue: r.isTrue })) });
    });
    room.botAssignments.forEach(a => {
      const b = room.bots.get(a.botId);
      allPlayerRules.push({ nickname: b?.nickname || '未知', hasFalse: a.hasFalse, rules: a.rules.map(r => ({ rule: r.rule, isTrue: r.isTrue })) });
    });
    
    const winner = goodScore >= badScore ? '正方（推理者）' : '反方（扰乱者）';
    room.phase = 'result';
    
    io.to(roomId).emit('gameResult', {
      results, falseHolders: correctFalseHolder, realMurderer,
      goodScore, badScore, winner,
      reasoning: caseData.reasoning, caseTitle: caseData.caseTitle,
      allPlayerRules, falseVotes, murdererVotes, majority,
      mostVotedFalse, mostVotedMurderer, falseCorrect, murdererCorrect,
      voteDetails
    });
  }

  socket.on('leaveRoom', ({ roomId }) => handleLeave(socket, roomId));
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.has(socket.id)) { handleLeave(socket, roomId); break; }
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
server.listen(PORT, () => console.log(`\n✅ 服务器运行在端口 ${PORT}`));

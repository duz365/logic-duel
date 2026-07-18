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
const API_TIMEOUT = 40000;

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
  room.players.forEach((info, id) => list.push({ id, nickname: info.nickname, isHost: id === room.host, isBot: false }));
  room.bots.forEach((info, id) => list.push({ id, nickname: info.nickname, isHost: false, isBot: true }));
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

// ==================== AI 生成案件 ====================
async function generateCase(playerCount) {
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`\n===== AI生成案件 ===== 玩家:${playerCount} 真:${trueCount} 假:${falseCount}`);
  
  if (!API_KEY) throw new Error('API_KEY未配置');

  const prompt = `生成推理案件。输出纯JSON。

硬性要求：
- 3个嫌疑人，每个名字至少在2条规则中出现
- 严格${trueCount}条真规则，${falseCount}条假规则
- 每条规则≤20字
- 真规则合起来唯一指向凶手，缺一不可
- 假规则与真规则逻辑矛盾但不是直接否定

{"caseTitle":"≤8字","caseDescription":"≤40字","suspects":["名1","名2","名3"],"murderer":"凶手名","trueRules":["规则"...共${trueCount}条],"falseRules":["规则"...共${falseCount}条],"reasoning":"≤80字"}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
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
        if (p.caseTitle && p.murderer && p.trueRules?.length >= trueCount && p.falseRules?.length >= falseCount && p.suspects?.length === 3) {
          console.log('✅', p.caseTitle, '| 凶手:', p.murderer);
          return { caseTitle: p.caseTitle, caseDescription: p.caseDescription || '', suspects: p.suspects, murderer: p.murderer, trueRules: p.trueRules.slice(0, trueCount), falseRules: p.falseRules.slice(0, falseCount), reasoning: p.reasoning || '' };
        }
      }
    } catch (e) { console.error('尝试失败:', e.message); }
  }
  throw new Error('AI案件生成失败');
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

// ==================== 人机讨论发言 ====================
async function generateBotDiscussionLine(botName, botRules, hasFalse, statements, suspects, caseDescription, realMurderer) {
  if (!API_KEY) return hasFalse ? "我觉得没那么简单。" : "关键线索出现了。";
  const myTrueRules = botRules.filter(r => r.isTrue).map(r => r.rule).join(';');
  const myFalseRules = botRules.filter(r => !r.isTrue).map(r => r.rule).join(';');
  const statementsText = statements.map(s => `${s.nickname}:"${s.rule}"`).join(';');
  const winCondition = hasFalse 
    ? `胜利条件：误导大家。真凶是${realMurderer}。你可以撒谎、歪曲、转移话题。`
    : `胜利条件：找出真相。引导大家正确指认假规则持有者和真凶${realMurderer}。`;

  const prompt = `你是"${botName}"。案件:${caseDescription}。嫌疑人:${suspects.join(',')}。真规则:${myTrueRules}。${myFalseRules?'假规则:'+myFalseRules:''}。公开规则:${statementsText}。${winCondition}发言≤20字。`;

  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
    const r = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`}, body:JSON.stringify({ model:'Qwen/Qwen2.5-7B-Instruct', messages:[{role:'user',content:prompt}], temperature:0.95, max_tokens:60 }), signal:c.signal });
    clearTimeout(t); const d = await r.json(); return d.choices[0].message.content.trim();
  } catch (e) { return hasFalse ? "别想太多。" : "这条线索重要。"; }
}

// ==================== 人机回复玩家 ====================
async function generateBotReply(botName, botRules, hasFalse, statements, suspects, caseDescription, realMurderer, playerMessage) {
  if (!API_KEY) return hasFalse ? "不一定。" : "同意。";
  const myTrueRules = botRules.filter(r => r.isTrue).map(r => r.rule).join(';');
  const myFalseRules = botRules.filter(r => !r.isTrue).map(r => r.rule).join(';');
  const statementsText = statements.map(s => `${s.nickname}:"${s.rule}"`).join(';');
  const winCondition = hasFalse ? `胜利条件：误导。真凶${realMurderer}。可撒谎。` : `胜利条件：推理。真凶${realMurderer}。`;

  const prompt = `"${botName}"。有人说:"${playerMessage}"。案件:${caseDescription}。真规则:${myTrueRules}。${myFalseRules?'假:'+myFalseRules:''}。公开:${statementsText}。${winCondition}回复≤15字。`;

  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`}, body:JSON.stringify({ model:'Qwen/Qwen2.5-7B-Instruct', messages:[{role:'user',content:prompt}], temperature:0.9, max_tokens:50 }), signal:c.signal });
    clearTimeout(t); const d = await r.json(); return d.choices[0].message.content.trim();
  } catch (e) { return hasFalse ? "再想想。" : "我同意。"; }
}

// ==================== 人机投票（多选） ====================
function botMakeAccusation(botRules, players, falseHolderCandidates, suspects, hasFalse, realMurderer) {
  const falseCount = Math.min(falseHolderCandidates.length, 1);
  let guessedFalsePlayers = [];
  
  if (hasFalse) {
    const wrongCandidates = players.filter(p => !falseHolderCandidates.includes(p.id));
    for (let i = 0; i < Math.max(1, falseHolderCandidates.length); i++) {
      if (wrongCandidates.length > 0) {
        const pick = wrongCandidates.splice(Math.floor(Math.random() * wrongCandidates.length), 1)[0];
        guessedFalsePlayers.push(pick.id);
      }
    }
  } else {
    const candidates = [...falseHolderCandidates];
    for (let i = 0; i < Math.max(1, falseHolderCandidates.length); i++) {
      if (candidates.length > 0 && Math.random() < 0.6) {
        guessedFalsePlayers.push(candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0]);
      } else {
        const others = players.filter(p => !guessedFalsePlayers.includes(p.id));
        if (others.length > 0) guessedFalsePlayers.push(others[Math.floor(Math.random() * others.length)].id);
      }
    }
  }
  
  let murdererGuess;
  if (hasFalse) {
    const wrong = suspects.filter(s => s !== realMurderer);
    murdererGuess = wrong.length > 0 ? wrong[Math.floor(Math.random() * wrong.length)] : suspects[0];
  } else {
    murdererGuess = Math.random() < 0.6 ? realMurderer : suspects[Math.floor(Math.random() * suspects.length)];
  }
  
  return { falsePlayerIds: [...new Set(guessedFalsePlayers)], murdererGuess };
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
    for (let i = 0; i < count; i++) room.bots.set(generateBotId(), { nickname: getBotName(room.bots.size + i), isBot: true });
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
  });

  socket.on('removeBots', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    room.bots.clear(); io.to(roomId).emit('playerListUpdate', getPlayersList(room));
  });

  socket.on('startGame', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    const totalPlayers = room.players.size + room.bots.size;
    if (totalPlayers < 2) { socket.emit('errorMessage', '至少2人'); return; }
    room.totalPlayers = totalPlayers;
    room.phase = 'preparing'; room.statementSubmitted = new Set();
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: 'AI生成案件中...' });
    
    try {
      room.caseData = await generateCase(totalPlayers);
    } catch (e) {
      socket.emit('errorMessage', '案件生成失败，请重试。');
      room.phase = 'lobby'; return;
    }
    
    const { falseCount } = getRuleCounts(totalPlayers);
    const assignments = assignRules(room.caseData.trueRules, room.caseData.falseRules, totalPlayers);
    const playerIds = Array.from(room.players.keys());
    room.playerAssignments = [];
    for (let i = 0; i < playerIds.length; i++) room.playerAssignments.push({ playerId: playerIds[i], rules: assignments[i].playerRules, hasFalse: assignments[i].hasFalse });
    const botIds = Array.from(room.bots.keys());
    room.botAssignments = [];
    for (let i = 0; i < botIds.length; i++) room.botAssignments.push({ botId: botIds[i], rules: assignments[playerIds.length + i].playerRules, hasFalse: assignments[playerIds.length + i].hasFalse });
    
    room.phase = 'reading'; room.statements = []; room.accusations = []; room.discussReady = new Set();
    io.to(roomId).emit('phaseChange', { phase: 'reading', message: '查看规则', totalPlayers, falseCount });
    for (const a of room.playerAssignments) {
      const ps = io.sockets.sockets.get(a.playerId);
      if (ps) ps.emit('yourRules', { rules: a.rules, hasFalseRule: a.hasFalse, caseTitle: room.caseData.caseTitle, caseDescription: room.caseData.caseDescription, suspects: room.caseData.suspects });
    }
    room.botAssignments.forEach((a) => {
      const timer = setTimeout(() => {
        if (room.phase === 'reading') {
          room.discussReady.add(a.botId);
          io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: totalPlayers });
          if (room.discussReady.size === totalPlayers) {
            room.phase = 'statement'; room.discussReady.clear(); room.statements = []; room.statementSubmitted = new Set();
            io.to(roomId).emit('phaseChange', { phase: 'statement', message: '陈述阶段', totalPlayers, falseCount });
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
          room.statements.push({ playerId: a.botId, nickname: room.bots.get(a.botId).nickname, rule });
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
      io.to(roomId).emit('phaseChange', { phase: 'discuss', message: '讨论', statements: room.statements, suspectList: room.caseData.suspects, totalPlayers: room.totalPlayers, falseCount: getRuleCounts(room.totalPlayers).falseCount });
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
            const line = await generateBotDiscussionLine(botInfo.nickname, a.rules, a.hasFalse, room.statements, room.caseData.suspects, room.caseData.caseDescription, room.caseData.murderer);
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
            const reply = await generateBotReply(botInfo.nickname, ba.rules, ba.hasFalse, room.statements, room.caseData.suspects, room.caseData.caseDescription, room.caseData.murderer, message);
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
      io.to(roomId).emit('phaseChange', { phase: 'statement', message: '陈述阶段', totalPlayers: room.totalPlayers, falseCount: getRuleCounts(room.totalPlayers).falseCount });
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
    clearBotTimers(room); startAccusationPhase(room, roomId);
  });

  function startAccusationPhase(room, roomId) {
    clearBotTimers(room);
    room.phase = 'accusation'; room.accusations = [];
    io.to(roomId).emit('phaseChange', { phase: 'accusation', message: '指控', players: getPlayersList(room), suspectList: room.caseData.suspects, totalPlayers: room.totalPlayers, falseCount: getRuleCounts(room.totalPlayers).falseCount });
    startBotAccusations(room, roomId);
  }

  function startBotAccusations(room, roomId) {
    const allPlayers = getPlayersList(room);
    const falseIds = room.botAssignments.filter(a => a.hasFalse).map(a => a.botId).concat(room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId));
    room.botAssignments.forEach((a) => {
      const timer = setTimeout(() => {
        if (room.phase === 'accusation') {
          const { falsePlayerIds, murdererGuess } = botMakeAccusation(a.rules, allPlayers.filter(p => p.id !== a.botId), falseIds.filter(id => id !== a.botId), room.caseData.suspects, a.hasFalse, room.caseData.murderer);
          room.accusations.push({ playerId: a.botId, nickname: room.bots.get(a.botId).nickname, falsePlayerIds, murdererGuess, isBot: true });
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
      (a.falsePlayerIds || []).forEach(id => {
        const n = (room.players.get(id) || room.bots.get(id))?.nickname || '?';
        fv[n] = (fv[n] || 0) + 1;
      });
      mv[a.murdererGuess] = (mv[a.murdererGuess] || 0) + 1;
    });
    const maj = Math.floor(room.totalPlayers / 2) + 1;
    io.to(roomId).emit('accusationsRevealed', { falseVotes: fv, murdererVotes: mv, totalPlayers: room.totalPlayers, majority: maj });
    setTimeout(() => calcResults(room, roomId, fv, mv, maj), 3000);
  }

  socket.on('submitAccusation', ({ roomId, falsePlayerIds, murdererGuess }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'accusation') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.accusations.push({ playerId: socket.id, nickname: player.nickname, falsePlayerIds, murdererGuess, isBot: false });
    io.to(roomId).emit('accusationUpdate', { submitted: room.accusations.length, total: room.totalPlayers });
    if (room.accusations.length === room.totalPlayers) revealAccusations(room, roomId);
  });

  function calcResults(room, roomId, fv, mv, maj) {
    clearBotTimers(room);
    const realM = room.caseData.murderer;
    const falseHolders = room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId).concat(room.botAssignments.filter(a => a.hasFalse).map(a => a.botId));
    const correctFH = falseHolders.map(id => (room.players.get(id) || room.bots.get(id))?.nickname).filter(Boolean);
    
    // 多选判定：所有真·假规则持有者都必须过半数，且没有冤假错案
    let fOk = true;
    for (const name of correctFH) { if ((fv[name] || 0) < maj) { fOk = false; break; } }
    for (const [name, count] of Object.entries(fv)) { if (count >= maj && !correctFH.includes(name)) { fOk = false; break; } }
    
    const topM = Object.entries(mv).sort((a,b) => b[1]-a[1])[0]?.[0];
    const mOk = topM === realM && (mv[topM]||0) >= maj;
    
    let gs = 0, bs = 0;
    if (fOk) gs++; else bs++;
    if (mOk) gs++; else bs++;
    
    const vd = room.accusations.map(a => ({
      nickname: a.nickname,
      votedFalsePlayer: (a.falsePlayerIds || []).map(id => (room.players.get(id) || room.bots.get(id))?.nickname || '?').join(', '),
      votedMurderer: a.murdererGuess,
      isBot: a.isBot || false
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
      falseCorrect: fOk, murdererCorrect: mOk, voteDetails: vd
    });
  }

  socket.on('leaveRoom', ({ roomId }) => handleLeave(socket, roomId));
  socket.on('disconnect', () => {
    for (const [rid, room] of rooms.entries()) { if (room.players.has(socket.id)) { handleLeave(socket, rid); break; } }
  });

  function handleLeave(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    clearBotTimers(room);
    room.players.delete(socket.id); room.discussReady.delete(socket.id);
    socket.leave(roomId);
    if (room.players.size === 0) { rooms.delete(roomId); return; }
    if (room.host === socket.id) room.host = room.players.keys().next().value;
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n✅ 端口 ${PORT}`));

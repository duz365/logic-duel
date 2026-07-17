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

// ==================== 配置 ====================
const API_KEY = 'sk-hzjjcnobtffqkoghmnnocbhuuhalkbfofrjhlsyhwemtjwdq';
const API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = 'deepseek-ai/DeepSeek-V4-Pro';
const MAX_DISCUSS_TIME = 10 * 60 * 1000;

// ==================== 房间管理 ====================
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getPlayersList(room) {
  return Array.from(room.players.entries()).map(([id, info]) => ({
    id,
    nickname: info.nickname,
    isHost: id === room.host
  }));
}

// ==================== AI 生成案件 ====================
async function generateCase() {
  const prompt = `你是一个逻辑谜题设计师。请生成一个严谨的推理案件。

要求：
1. 案件必须有一个明确的凶手。
2. 生成6条"真规则"（逻辑线索），合起来能唯一指向凶手。
3. 生成2条"假规则"（表面合理但与真规则逻辑矛盾）。
4. 每条规则用简洁的陈述句，不超过30字。
5. 真规则集必须满足：缺失任何一条都无法确定凶手。
6. 假规则不能是真规则的直接否定，要是"逻辑变体"。

输出格式（严格JSON，不要任何其他文字，不要markdown代码块标记）：
{
  "caseTitle": "案件标题",
  "caseDescription": "案件描述，100字以内",
  "suspects": ["嫌疑人A", "嫌疑人B", "嫌疑人C"],
  "murderer": "凶手名字（必须是suspects中的一个）",
  "trueRules": ["真规则1", "真规则2", "真规则3", "真规则4", "真规则5", "真规则6"],
  "falseRules": ["假规则1", "假规则2"],
  "reasoning": "完整的逻辑推理链，说明真规则如何唯一指向凶手"
}`;

  if (!API_KEY) {
    return getDefaultCase();
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      console.error('API请求失败:', response.status);
      return getDefaultCase();
    }

    const data = await response.json();
    let content = data.choices[0].message.content;
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(content);
    if (!parsed.murderer || !parsed.trueRules || !parsed.falseRules) {
      throw new Error('返回数据不完整');
    }
    return parsed;
  } catch (error) {
    console.error('AI生成案件失败:', error.message);
    return getDefaultCase();
  }
}

function getDefaultCase() {
  return {
    caseTitle: "博物馆失窃案",
    caseDescription: "深夜，市博物馆的名画《星空下的猫》被盗。现场有三个嫌疑人：保安张三、清洁工李四、馆长王五。只有一人是真正的小偷。",
    suspects: ["保安张三", "清洁工李四", "馆长王五"],
    murderer: "清洁工李四",
    trueRules: [
      "监控显示案发时间有两人进入过展厅",
      "保安张三和馆长王五在案发时间在一起喝酒",
      "小偷身高不超过175cm",
      "清洁工李四身高170cm",
      "馆长王五身高182cm",
      "保安张三身高178cm"
    ],
    falseRules: [
      "监控显示案发时间只有一人进入过展厅",
      "清洁工李四在案发时间已经下班回家"
    ],
    reasoning: "监控显示两人进入展厅，排除单独作案可能。张三和王五在案发时间一起喝酒，互相作证，两人均被排除。小偷身高不超过175cm，王五182cm、张三178cm均不符合，只有李四170cm符合条件。因此李四是小偷。"
  };
}

// ==================== 规则分配 ====================
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function assignRules(trueRules, falseRules, playerCount) {
  const shuffledTrue = shuffleArray(trueRules);
  const falseCount = Math.min(2, playerCount - 1);
  const shuffledFalse = shuffleArray(falseRules).slice(0, falseCount);
  
  const assignments = [];
  const falseHolderIndices = shuffleArray([...Array(playerCount).keys()]).slice(0, falseCount);
  let trueIndex = 0;
  let falseIndex = 0;
  
  for (let i = 0; i < playerCount; i++) {
    const playerRules = [];
    const trueCount = Math.floor(trueRules.length / playerCount) + (i < trueRules.length % playerCount ? 1 : 0);
    for (let j = 0; j < trueCount && trueIndex < shuffledTrue.length; j++) {
      playerRules.push({ rule: shuffledTrue[trueIndex], isTrue: true });
      trueIndex++;
    }
    
    if (falseHolderIndices.includes(i) && falseIndex < shuffledFalse.length) {
      playerRules.push({ rule: shuffledFalse[falseIndex], isTrue: false });
      falseIndex++;
    }
    
    assignments.push({ playerIndex: i, playerRules, hasFalse: falseHolderIndices.includes(i) });
  }
  
  return assignments;
}

// ==================== Socket ====================
io.on('connection', (socket) => {
  console.log('连接:', socket.id);

  socket.on('joinRoom', ({ nickname, roomId }) => {
    if (!nickname) return;
    const targetRoomId = roomId || generateRoomId();
    
    if (!rooms.has(targetRoomId)) {
      rooms.set(targetRoomId, {
        players: new Map(),
        host: socket.id,
        phase: 'lobby',
        caseData: null,
        playerAssignments: [],
        statements: [],
        accusations: [],
        discussReady: new Set(),
      });
    }

    const room = rooms.get(targetRoomId);
    room.players.set(socket.id, { nickname });
    socket.join(targetRoomId);
    
    socket.emit('roomJoined', {
      roomId: targetRoomId,
      playerId: socket.id,
      players: getPlayersList(room),
      phase: room.phase,
      isHost: room.host === socket.id
    });
    
    io.to(targetRoomId).emit('playerListUpdate', getPlayersList(room));
  });

  socket.on('startGame', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    if (room.players.size < 2) {
      socket.emit('errorMessage', '至少需要2名玩家');
      return;
    }

    room.phase = 'preparing';
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: '正在生成案件...' });

    const caseData = await generateCase();
    room.caseData = caseData;
    
    const playerIds = Array.from(room.players.keys());
    const assignments = assignRules(caseData.trueRules, caseData.falseRules, playerIds.length);
    
    room.playerAssignments = [];
    for (let i = 0; i < playerIds.length; i++) {
      room.playerAssignments.push({
        playerId: playerIds[i],
        rules: assignments[i].playerRules,
        hasFalse: assignments[i].hasFalse
      });
    }

    room.phase = 'reading';
    room.statements = [];
    room.accusations = [];
    room.discussReady = new Set();
    
    io.to(roomId).emit('phaseChange', { phase: 'reading', message: '请查看你的规则手册' });
    
    for (const assignment of room.playerAssignments) {
      const ps = io.sockets.sockets.get(assignment.playerId);
      if (ps) {
        ps.emit('yourRules', {
          rules: assignment.rules,
          caseTitle: caseData.caseTitle,
          caseDescription: caseData.caseDescription,
          suspects: caseData.suspects
        });
      }
    }
  });

  socket.on('readyToStatement', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'reading') return;
    room.discussReady.add(socket.id);
    io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.players.size });
    
    if (room.discussReady.size === room.players.size) {
      room.phase = 'statement';
      room.discussReady.clear();
      room.statements = [];
      io.to(roomId).emit('phaseChange', {
        phase: 'statement',
        message: '陈述阶段：每人选择一条规则公开（不可说谎）'
      });
    }
  });

  socket.on('submitStatement', ({ roomId, rule }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'statement') return;
    const player = room.players.get(socket.id);
    room.statements.push({ playerId: socket.id, nickname: player.nickname, rule });
    io.to(roomId).emit('statementUpdate', room.statements);
    
    if (room.statements.length === room.players.size) {
      setTimeout(() => {
        room.phase = 'discuss';
        room.discussReady.clear();
        io.to(roomId).emit('phaseChange', {
          phase: 'discuss',
          message: '讨论阶段：分析逻辑矛盾，找出假规则和凶手',
          statements: room.statements,
          suspectList: room.caseData.suspects
        });
        
        setTimeout(() => {
          if (room.phase === 'discuss') {
            io.to(roomId).emit('discussTimeout');
          }
        }, MAX_DISCUSS_TIME);
      }, 1500);
    }
  });

  socket.on('chatMessage', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'discuss') return;
    const player = room.players.get(socket.id);
    if (player) {
      io.to(roomId).emit('chatMessage', { from: player.nickname, message });
    }
  });

  socket.on('readyToAccusation', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'discuss') return;
    room.discussReady.add(socket.id);
    io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.players.size });
    
    if (room.discussReady.size === room.players.size) {
      startAccusationPhase(room);
    }
  });

  socket.on('forceAccusation', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.phase !== 'discuss') return;
    startAccusationPhase(room);
  });

  socket.on('submitAccusation', ({ roomId, falsePlayerId, murdererGuess }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'accusation') return;
    const player = room.players.get(socket.id);
    
    room.accusations.push({
      playerId: socket.id,
      nickname: player.nickname,
      falsePlayerId,
      murdererGuess
    });
    
    io.to(roomId).emit('accusationUpdate', {
      submitted: room.accusations.length,
      total: room.players.size
    });
    
    if (room.accusations.length === room.players.size) {
      calculateResults(room);
    }
  });

  socket.on('leaveRoom', ({ roomId }) => handleLeave(socket, roomId));
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        handleLeave(socket, roomId);
        break;
      }
    }
  });

  function handleLeave(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.delete(socket.id);
    room.discussReady.delete(socket.id);
    socket.leave(roomId);
    if (room.players.size === 0) {
      rooms.delete(roomId);
      return;
    }
    if (room.host === socket.id) {
      room.host = room.players.keys().next().value;
    }
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
  }
});

function startAccusationPhase(room) {
  room.phase = 'accusation';
  room.accusations = [];
  const players = getPlayersList(room);
  io.to(room.host ? Array.from(rooms.entries()).find(([id, r]) => r === room)?.[0] : '').emit('phaseChange', {
    phase: 'accusation',
    message: '指控阶段：指出谁持有假规则，以及谁是凶手',
    players,
    suspectList: room.caseData.suspects
  });
  // 修复：广播到房间
  for (const [rid, r] of rooms.entries()) {
    if (r === room) {
      io.to(rid).emit('phaseChange', {
        phase: 'accusation',
        message: '指控阶段：指出谁持有假规则，以及谁是凶手',
        players,
        suspectList: room.caseData.suspects
      });
      break;
    }
  }
}

function calculateResults(room) {
  const caseData = room.caseData;
  const realMurderer = caseData.murderer;
  const falseHolders = room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId);
  
  const results = [];
  let goodScore = 0;
  let badScore = 0;
  
  for (const acc of room.accusations) {
    const guessedFalseCorrect = falseHolders.includes(acc.falsePlayerId);
    const guessedMurdererCorrect = (acc.murdererGuess === realMurderer);
    const isFalseHolder = falseHolders.includes(acc.playerId);
    
    results.push({
      nickname: acc.nickname,
      guessedFalsePlayer: room.players.get(acc.falsePlayerId)?.nickname || '未知',
      guessedMurderer: acc.murdererGuess,
      guessedFalseCorrect,
      guessedMurdererCorrect,
      isFalseHolder
    });
    
    if (!isFalseHolder) {
      if (guessedFalseCorrect) goodScore++; else badScore++;
      if (guessedMurdererCorrect) goodScore++; else badScore++;
    }
  }
  
  const winner = goodScore >= badScore ? '正方（推理者）' : '反方（误导者）';
  room.phase = 'result';
  
  for (const [rid, r] of rooms.entries()) {
    if (r === room) {
      io.to(rid).emit('gameResult', {
        results,
        falseHolders: falseHolders.map(id => room.players.get(id)?.nickname),
        realMurderer,
        goodScore,
        badScore,
        winner,
        reasoning: caseData.reasoning,
        caseTitle: caseData.caseTitle
      });
      break;
    }
  }
}

// ==================== 启动 ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});

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
const API_KEY = process.env.SILICONFLOW_API_KEY || '';
const API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const MAX_DISCUSS_TIME = 10 * 60 * 1000;
const API_TIMEOUT = 30000; // 30秒超时

console.log('========================================');
console.log('服务器启动中...');
console.log('API_KEY 存在:', !!API_KEY);
console.log('API_KEY 前6位:', API_KEY ? API_KEY.substring(0, 6) : '无');
console.log('模型:', MODEL);
console.log('API超时:', API_TIMEOUT/1000, '秒');
console.log('========================================');

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

// ==================== 规则分配逻辑 ====================
function getRuleCounts(playerCount) {
  const totalRules = playerCount * 2;
  
  let falseCount;
  if (playerCount <= 4) {
    falseCount = 1;
  } else if (playerCount <= 6) {
    falseCount = 2;
  } else {
    falseCount = 3;
  }
  
  const trueCount = totalRules - falseCount;
  
  return { totalRules, trueCount, falseCount };
}

// ==================== AI 生成案件 ====================
async function generateCase(playerCount) {
  console.log('\n===== 开始生成案件 =====');
  console.log('玩家数:', playerCount);
  
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`真规则: ${trueCount}条, 假规则: ${falseCount}条`);
  
  if (!API_KEY) {
    console.log('❌ 没有API_KEY，使用默认案件');
    return getDefaultCase();
  }

  const prompt = `你是一个逻辑谜题设计师。请生成一个严谨的推理案件。

要求：
1. 案件有3个嫌疑人，其中一个是明确的凶手。
2. 生成${trueCount}条"真规则"（逻辑线索），合起来能唯一指向凶手。
3. 生成${falseCount}条"假规则"（表面合理但与真规则逻辑矛盾）。
4. 每条规则用简洁的陈述句，不超过30字。
5. 真规则集必须满足：缺失任何一条都无法确定凶手（每条都是必要条件）。
6. 假规则不能是真规则的直接否定，要是"逻辑变体"。

输出格式（纯JSON，不要markdown标记，不要注释）：
{
  "caseTitle": "案件标题",
  "caseDescription": "案件描述，100字以内",
  "suspects": ["嫌疑人A", "嫌疑人B", "嫌疑人C"],
  "murderer": "凶手名字（必须是suspects中的一个）",
  "trueRules": [${Array(trueCount).fill('"规则"').join(', ')}],
  "falseRules": [${Array(falseCount).fill('"规则"').join(', ')}],
  "reasoning": "完整的逻辑推理链"
}`;

  try {
    console.log('正在调用硅基流动API...');
    console.log('开始时间:', new Date().toLocaleTimeString());
    
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      console.log('⏰ API调用超时(' + API_TIMEOUT/1000 + '秒)');
      controller.abort();
    }, API_TIMEOUT);

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
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    console.log('API响应状态:', response.status);
    console.log('结束时间:', new Date().toLocaleTimeString());

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ API请求失败:', response.status);
      console.error('错误详情:', errorText.substring(0, 200));
      return getDefaultCase();
    }

    const data = await response.json();
    let content = data.choices[0].message.content;
    console.log('原始返回长度:', content.length);
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(content);
    console.log('✅ AI案件生成成功:', parsed.caseTitle);
    console.log('凶手:', parsed.murderer);
    console.log('真规则数:', parsed.trueRules?.length, '假规则数:', parsed.falseRules?.length);
    return parsed;
    
  } catch (error) {
    console.error('❌ API调用异常:', error.message);
    if (error.name === 'AbortError') {
      console.error('请求被中止（超时）');
    }
    return getDefaultCase();
  }
}

function getDefaultCase() {
  console.log('使用默认案件');
  return {
    caseTitle: "博物馆失窃案",
    caseDescription: "深夜，市博物馆的名画《星空下的猫》被盗。现场有三个嫌疑人：保安张三、清洁工李四、馆长王五。",
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
      "监控显示案发时间只有一人进入过展厅"
    ],
    reasoning: "监控显示两人进入展厅，排除单独作案。张三和王五一起喝酒互相作证，两人排除。小偷身高≤175cm，王五182cm、张三178cm不符合，只有李四170cm符合。"
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
  const shuffledFalse = shuffleArray(falseRules);
  
  const falseHolderIndices = shuffleArray([...Array(playerCount).keys()]).slice(0, shuffledFalse.length);
  
  const assignments = [];
  let trueIndex = 0;
  let falseIndex = 0;
  
  for (let i = 0; i < playerCount; i++) {
    const playerRules = [];
    
    if (falseHolderIndices.includes(i) && falseIndex < shuffledFalse.length) {
      playerRules.push({ rule: shuffledFalse[falseIndex], isTrue: false });
      falseIndex++;
      playerRules.push({ rule: shuffledTrue[trueIndex], isTrue: true });
      trueIndex++;
    } else {
      playerRules.push({ rule: shuffledTrue[trueIndex], isTrue: true });
      trueIndex++;
      playerRules.push({ rule: shuffledTrue[trueIndex], isTrue: true });
      trueIndex++;
    }
    
    assignments.push({ 
      playerIndex: i, 
      playerRules, 
      hasFalse: falseHolderIndices.includes(i) 
    });
  }
  
  console.log('规则分配:');
  assignments.forEach((a, i) => {
    const rules = a.playerRules.map(r => `${r.isTrue ? '真' : '假'}:${r.rule.substring(0, 15)}...`);
    console.log(`  玩家${i}: [${rules.join(', ')}] ${a.hasFalse ? '🔴持有假规则' : '🟢纯真规则'}`);
  });
  
  return assignments;
}

// ==================== Socket ====================
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);

  socket.on('joinRoom', ({ nickname, roomId }) => {
    if (!nickname) return;
    const targetRoomId = roomId || generateRoomId();
    console.log(`${nickname} 加入房间 ${targetRoomId}`);
    
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

    const playerCount = room.players.size;
    console.log(`\n🎮 开始游戏，房间: ${roomId}，玩家数: ${playerCount}`);
    room.phase = 'preparing';
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: '正在生成案件...' });

    const caseData = await generateCase(playerCount);
    room.caseData = caseData;
    
    const playerIds = Array.from(room.players.keys());
    const assignments = assignRules(caseData.trueRules, caseData.falseRules, playerCount);
    
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
    
    io.to(roomId).emit('phaseChange', { phase: 'reading', message: '请查看你的规则手册（每人2条规则）' });
    
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
    
    console.log('案件已分发，进入阅读阶段');
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
      startAccusationPhase(room, roomId);
    }
  });

  socket.on('forceAccusation', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.phase !== 'discuss') return;
    startAccusationPhase(room, roomId);
  });

  function startAccusationPhase(room, roomId) {
    room.phase = 'accusation';
    room.accusations = [];
    const players = getPlayersList(room);
    io.to(roomId).emit('phaseChange', {
      phase: 'accusation',
      message: '指控阶段：指出谁持有假规则，以及谁是凶手',
      players,
      suspectList: room.caseData.suspects
    });
  }

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
      calculateResults(room, roomId);
    }
  });

  function calculateResults(room, roomId) {
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
    
    io.to(roomId).emit('gameResult', {
      results,
      falseHolders: falseHolders.map(id => room.players.get(id)?.nickname),
      realMurderer,
      goodScore,
      badScore,
      winner,
      reasoning: caseData.reasoning,
      caseTitle: caseData.caseTitle
    });
  }

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ 服务器运行在端口 ${PORT}`);
});

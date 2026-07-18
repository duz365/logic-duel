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
const API_TIMEOUT = 30000;

console.log('========================================');
console.log('服务器启动中...');
console.log('API_KEY 存在:', !!API_KEY);
console.log('模型:', MODEL);
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

// ==================== 预设案件库 ====================
const presetCases = [
  {
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
      "保安张三身高178cm",
      "展厅窗户从内部锁着，没有被撬痕迹",
      "清洁工李四有展厅的备用钥匙"
    ],
    falseRules: [
      "监控显示案发时间只有一人进入过展厅",
      "清洁工李四在案发时间已经下班回家"
    ],
    reasoning: "监控显示两人进入展厅，排除单独作案。张三和王五一起喝酒互相作证，两人排除。小偷身高≤175cm，王五182cm、张三178cm不符合，只有李四170cm符合。窗户内部锁着说明是内部人员作案，李四有备用钥匙。因此李四是小偷。"
  },
  {
    caseTitle: "毒杀晚宴",
    caseDescription: "富豪王某在家中举办晚宴时中毒身亡。当晚只有三个人接触过他的酒杯：他的妻子王太太、商业伙伴老张、私人医生陈医生。",
    suspects: ["王太太", "老张", "陈医生"],
    murderer: "王太太",
    trueRules: [
      "毒药在红酒中，需要5分钟才会发作",
      "王太太在案发前10分钟给王某倒过酒",
      "老张在案发前3分钟和王某碰过杯",
      "陈医生在案发前8分钟给王某递过药",
      "毒药遇到水会变成蓝色",
      "王某的酒杯内壁有蓝色残留",
      "陈医生的药是胶囊，不接触酒杯",
      "老张和王某喝的是同一瓶酒，老张没事"
    ],
    falseRules: [
      "毒药是速效的，1分钟内发作",
      "陈医生的药和水接触后会变蓝"
    ],
    reasoning: "毒药5分钟发作+酒杯有蓝色残留=毒在酒里且接触了水。陈医生给的是胶囊不接触酒杯，排除。老张和王某喝同一瓶酒却没事，说明毒不在酒瓶里，排除老张。王太太倒酒时最有机会下毒，且10分钟前倒酒符合5分钟发作时间线。因此王太太是凶手。"
  },
  {
    caseTitle: "坠楼疑云",
    caseDescription: "某公司员工李某从18楼坠亡。警方锁定三名嫌疑人：他的上司赵总、同事小周、以及前女友孙小姐。",
    suspects: ["赵总", "小周", "孙小姐"],
    murderer: "赵总",
    trueRules: [
      "李某坠楼前收到一条短信，内容是'来天台'",
      "赵总的手机在案发时间给李某发过短信",
      "天台的监控在案发当天被人为关闭",
      "孙小姐在案发时有不在场证明，她在医院陪护",
      "小周和赵总在案发后互相指认对方",
      "李某的指甲里有皮肤组织，DNA属于赵总",
      "赵总的手腕上有新鲜的抓痕",
      "李某的办公桌里有一封举报赵总贪污的信"
    ],
    falseRules: [
      "天台监控在案发当天正常工作",
      "孙小姐在案发时出现在公司大楼"
    ],
    reasoning: "指甲DNA+手腕抓痕=李某和赵总有过肢体冲突。发短信约天台+关监控=预谋。孙小姐有不在场证明，排除。小周和赵总互相指认，但物理证据指向赵总。举报信提供了动机。因此赵总是凶手。"
  }
];

// ==================== AI 生成案件 ====================
async function generateCase(playerCount) {
  console.log('\n===== 开始生成案件 =====');
  console.log('玩家数:', playerCount);
  
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`真规则: ${trueCount}条, 假规则: ${falseCount}条`);
  
  // 优先从预设案件中选
  const suitableCases = presetCases.filter(c => 
    c.trueRules.length >= trueCount && c.falseRules.length >= falseCount
  );
  
  if (suitableCases.length > 0) {
    const selected = suitableCases[Math.floor(Math.random() * suitableCases.length)];
    console.log('✅ 使用预设案件:', selected.caseTitle);
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
  
  // 预设案件不够，尝试 AI
  if (!API_KEY) {
    console.log('❌ 没有API_KEY且预设案件不足，使用默认案件');
    return getDefaultCase();
  }

  const prompt = `生成一个推理案件。输出纯JSON，不要markdown，不要注释。

案件要求：
- 3个嫌疑人，其中1个是明确的凶手
- ${trueCount}条真规则（逻辑线索，合起来唯一指向凶手）
- ${falseCount}条假规则（表面合理但与真规则逻辑矛盾）
- 每条规则不超过30字
- 缺失任何一条真规则都无法确定凶手
- 假规则不能是真规则的直接否定

输出格式：
{"caseTitle":"标题","caseDescription":"描述100字内","suspects":["A","B","C"],"murderer":"凶手名","trueRules":["规则1"...共${trueCount}条],"falseRules":["规则1"...共${falseCount}条],"reasoning":"推理链"}`;

  try {
    console.log('正在调用AI...');
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);

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
        max_tokens: 1500
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    console.log('AI响应状态:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI错误:', response.status, errorText.substring(0, 200));
      return getDefaultCase();
    }

    const data = await response.json();
    let content = data.choices[0].message.content;
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(content);
    console.log('✅ AI案件:', parsed.caseTitle);
    return parsed;
    
  } catch (error) {
    console.error('❌ AI异常:', error.message);
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
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: '正在准备案件...' });

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
          hasFalseRule: assignment.hasFalse,
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
    
    // 构建所有玩家的规则展示
    const allPlayerRules = room.playerAssignments.map(a => {
      const player = room.players.get(a.playerId);
      return {
        nickname: player?.nickname || '未知',
        hasFalse: a.hasFalse,
        rules: a.rules.map(r => ({
          rule: r.rule,
          isTrue: r.isTrue
        }))
      };
    });
    
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
      caseTitle: caseData.caseTitle,
      allPlayerRules
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

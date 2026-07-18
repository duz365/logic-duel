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

function generateBotId() {
  return 'bot_' + Math.random().toString(36).substring(2, 8);
}

function getPlayersList(room) {
  const list = [];
  room.players.forEach((info, id) => {
    list.push({
      id,
      nickname: info.nickname,
      isHost: id === room.host,
      isBot: info.isBot || false
    });
  });
  room.bots.forEach((info, id) => {
    list.push({
      id,
      nickname: info.nickname,
      isHost: false,
      isBot: true
    });
  });
  return list;
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

// ==================== 人机发言库 ====================
const botDiscussLines = {
  honest: [
    "我觉得我们需要仔细对比一下大家公开的规则，看看有没有矛盾的地方。",
    "我刚才注意到有一条规则和其他人的好像对不上，有人能解释一下吗？",
    "按照目前公开的规则来看，嫌疑人应该是...让我再想想。",
    "我怀疑有人公开了假规则，但不确定是谁。",
    "大家冷静分析，别急着下结论。先看看哪些规则是一致的。",
    "如果我的推理没错的话，真凶应该符合所有真规则的条件。"
  ],
  misleading: [
    "我觉得大家都想多了，可能就是最简单的那个答案。",
    "我公开的规则肯定是没问题的，其他人的我就不知道了。",
    "我觉得凶手可能是另一个人，大家的方向是不是偏了？",
    "有些规则看起来合理，但合在一起就很奇怪，是不是有人...",
    "我建议大家重新看看每条规则，说不定有遗漏。"
  ]
};

// ==================== AI 生成案件 ====================
async function generateCase(playerCount) {
  console.log('\n===== 开始生成案件 =====');
  console.log('玩家数:', playerCount);
  
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`真规则: ${trueCount}条, 假规则: ${falseCount}条`);
  
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

function assignRules(trueRules, falseRules, totalPlayers) {
  const shuffledTrue = shuffleArray(trueRules);
  const shuffledFalse = shuffleArray(falseRules);
  
  const falseHolderIndices = shuffleArray([...Array(totalPlayers).keys()]).slice(0, shuffledFalse.length);
  
  const assignments = [];
  let trueIndex = 0;
  let falseIndex = 0;
  
  for (let i = 0; i < totalPlayers; i++) {
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
  
  return assignments;
}

// ==================== 人机逻辑 ====================
function getBotName(index) {
  const names = ['侦探小王', '推理达人', '逻辑怪', '福尔摩斯猫', '机智老张', '观察者小李'];
  return names[index % names.length];
}

function botSelectStatement(botRules) {
  // 如果有真规则，优先选真规则公开
  const trueRules = botRules.filter(r => r.isTrue);
  if (trueRules.length > 0) {
    return trueRules[Math.floor(Math.random() * trueRules.length)].rule;
  }
  return botRules[Math.floor(Math.random() * botRules.length)].rule;
}

function botMakeAccusation(botRules, players, falseHolderCandidates, suspects) {
  // 人机推理：随机但有倾向性
  // 60%概率选对人，40%概率选错（模拟真实玩家的不确定性）
  const accuracy = 0.6;
  
  let guessedFalsePlayer;
  if (Math.random() < accuracy && falseHolderCandidates.length > 0) {
    guessedFalsePlayer = falseHolderCandidates[Math.floor(Math.random() * falseHolderCandidates.length)];
  } else {
    // 随机选一个其他玩家
    const others = players.filter(p => !p.isBot || p.id !== 'self');
    if (others.length > 0) {
      guessedFalsePlayer = others[Math.floor(Math.random() * others.length)].id;
    } else {
      guessedFalsePlayer = players[0]?.id;
    }
  }
  
  const murdererGuess = suspects[Math.floor(Math.random() * suspects.length)];
  
  return { falsePlayerId: guessedFalsePlayer, murdererGuess };
}

function getBotDiscussLine(isFalseHolder) {
  const pool = isFalseHolder ? botDiscussLines.misleading : botDiscussLines.honest;
  return pool[Math.floor(Math.random() * pool.length)];
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
        bots: new Map(),
        host: socket.id,
        phase: 'lobby',
        caseData: null,
        playerAssignments: [],
        botAssignments: [],
        statements: [],
        accusations: [],
        discussReady: new Set(),
        botTimers: [],
        totalPlayers: 0,
      });
    }

    const room = rooms.get(targetRoomId);
    room.players.set(socket.id, { nickname, isBot: false });
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

  // 添加人机
  socket.on('addBots', ({ roomId, count }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    if (room.phase !== 'lobby') {
      socket.emit('errorMessage', '只能在游戏开始前添加人机');
      return;
    }
    
    const currentBots = room.bots.size;
    for (let i = 0; i < count; i++) {
      const botId = generateBotId();
      room.bots.set(botId, { nickname: getBotName(currentBots + i), isBot: true });
    }
    
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
    console.log(`房间 ${roomId} 添加了 ${count} 个人机`);
  });

  // 移除人机
  socket.on('removeBots', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    if (room.phase !== 'lobby') return;
    
    room.bots.clear();
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
    console.log(`房间 ${roomId} 清除了所有人机`);
  });

  socket.on('startGame', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    
    const totalPlayers = room.players.size + room.bots.size;
    if (totalPlayers < 2) {
      socket.emit('errorMessage', '至少需要2名玩家（包括人机）');
      return;
    }

    room.totalPlayers = totalPlayers;
    console.log(`\n🎮 开始游戏，房间: ${roomId}，真人: ${room.players.size}，人机: ${room.bots.size}，总计: ${totalPlayers}`);
    room.phase = 'preparing';
    io.to(roomId).emit('phaseChange', { phase: 'preparing', message: '正在准备案件...' });

    const caseData = await generateCase(totalPlayers);
    room.caseData = caseData;
    
    const assignments = assignRules(caseData.trueRules, caseData.falseRules, totalPlayers);
    
    // 分配给真人
    const playerIds = Array.from(room.players.keys());
    room.playerAssignments = [];
    for (let i = 0; i < playerIds.length; i++) {
      room.playerAssignments.push({
        playerId: playerIds[i],
        rules: assignments[i].playerRules,
        hasFalse: assignments[i].hasFalse
      });
    }
    
    // 分配给人机
    const botIds = Array.from(room.bots.keys());
    room.botAssignments = [];
    for (let i = 0; i < botIds.length; i++) {
      room.botAssignments.push({
        botId: botIds[i],
        rules: assignments[playerIds.length + i].playerRules,
        hasFalse: assignments[playerIds.length + i].hasFalse
      });
    }

    room.phase = 'reading';
    room.statements = [];
    room.accusations = [];
    room.discussReady = new Set();
    
    io.to(roomId).emit('phaseChange', { phase: 'reading', message: '请查看你的规则手册（每人2条规则）' });
    
    // 发送给真人
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
    
    // 人机自动确认阅读（随机延迟）
    room.botAssignments.forEach((assignment, index) => {
      const delay = 2000 + Math.random() * 3000;
      const timer = setTimeout(() => {
        if (room.phase === 'reading') {
          room.discussReady.add(assignment.botId);
          io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: totalPlayers });
          
          if (room.discussReady.size === totalPlayers) {
            room.phase = 'statement';
            room.discussReady.clear();
            room.statements = [];
            io.to(roomId).emit('phaseChange', {
              phase: 'statement',
              message: '陈述阶段：每人选择一条规则公开（不可说谎）'
            });
            
            // 人机自动陈述
            startBotStatements(room, roomId);
          }
        }
      }, delay);
      room.botTimers.push(timer);
    });
    
    console.log('案件已分发，进入阅读阶段');
  });

  function startBotStatements(room, roomId) {
    room.botAssignments.forEach((assignment, index) => {
      const delay = 3000 + Math.random() * 4000;
      const timer = setTimeout(() => {
        if (room.phase === 'statement') {
          const rule = botSelectStatement(assignment.rules);
          const botInfo = room.bots.get(assignment.botId);
          room.statements.push({ playerId: assignment.botId, nickname: botInfo.nickname, rule });
          io.to(roomId).emit('statementUpdate', room.statements);
          
          if (room.statements.length === room.totalPlayers) {
            setTimeout(() => {
              room.phase = 'discuss';
              room.discussReady.clear();
              io.to(roomId).emit('phaseChange', {
                phase: 'discuss',
                message: '讨论阶段：分析逻辑矛盾，找出假规则和凶手',
                statements: room.statements,
                suspectList: room.caseData.suspects
              });
              
              // 人机参与讨论
              startBotDiscussion(room, roomId);
              
              setTimeout(() => {
                if (room.phase === 'discuss') {
                  io.to(roomId).emit('discussTimeout');
                }
              }, MAX_DISCUSS_TIME);
            }, 1500);
          }
        }
      }, delay);
      room.botTimers.push(timer);
    });
  }

  function startBotDiscussion(room, roomId) {
    room.botAssignments.forEach((assignment, index) => {
      // 每个人机发1-3条消息
      const msgCount = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < msgCount; i++) {
        const delay = 5000 + i * 8000 + Math.random() * 5000;
        const timer = setTimeout(() => {
          if (room.phase === 'discuss') {
            const botInfo = room.bots.get(assignment.botId);
            const line = getBotDiscussLine(assignment.hasFalse);
            io.to(roomId).emit('chatMessage', { from: botInfo.nickname, message: line });
          }
        }, delay);
        room.botTimers.push(timer);
      }
    });
  }

  // 人机自动同意进入指控
  function startBotReadyToAccusation(room, roomId) {
    room.botAssignments.forEach((assignment, index) => {
      const delay = 3000 + Math.random() * 5000;
      const timer = setTimeout(() => {
        if (room.phase === 'discuss') {
          room.discussReady.add(assignment.botId);
          io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
          
          if (room.discussReady.size === room.totalPlayers) {
            startAccusationPhase(room, roomId);
          }
        }
      }, delay);
      room.botTimers.push(timer);
    });
  }

  // 重写讨论阶段的 readyToAccusation，加入人机自动确认
  const originalReadyToAccusation = socket.listeners('readyToAccusation');
  
  socket.on('readyToStatement', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'reading') return;
    room.discussReady.add(socket.id);
    io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
    
    if (room.discussReady.size === room.totalPlayers) {
      room.phase = 'statement';
      room.discussReady.clear();
      room.statements = [];
      io.to(roomId).emit('phaseChange', {
        phase: 'statement',
        message: '陈述阶段：每人选择一条规则公开（不可说谎）'
      });
      startBotStatements(room, roomId);
    }
  });

  socket.on('submitStatement', ({ roomId, rule }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'statement') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.statements.push({ playerId: socket.id, nickname: player.nickname, rule });
    io.to(roomId).emit('statementUpdate', room.statements);
    
    if (room.statements.length === room.totalPlayers) {
      setTimeout(() => {
        room.phase = 'discuss';
        room.discussReady.clear();
        io.to(roomId).emit('phaseChange', {
          phase: 'discuss',
          message: '讨论阶段：分析逻辑矛盾，找出假规则和凶手',
          statements: room.statements,
          suspectList: room.caseData.suspects
        });
        startBotDiscussion(room, roomId);
        
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
    io.to(roomId).emit('readyProgress', { ready: room.discussReady.size, total: room.totalPlayers });
    
    // 第一个真人点击后，人机也开始确认
    if (room.discussReady.size === 1) {
      startBotReadyToAccusation(room, roomId);
    }
    
    if (room.discussReady.size === room.totalPlayers) {
      startAccusationPhase(room, roomId);
    }
  });

  socket.on('forceAccusation', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.phase !== 'discuss') return;
    clearBotTimers(room);
    startAccusationPhase(room, roomId);
  });

  function clearBotTimers(room) {
    room.botTimers.forEach(t => clearTimeout(t));
    room.botTimers = [];
  }

  function startAccusationPhase(room, roomId) {
    clearBotTimers(room);
    room.phase = 'accusation';
    room.accusations = [];
    const players = getPlayersList(room);
    io.to(roomId).emit('phaseChange', {
      phase: 'accusation',
      message: '指控阶段：指出谁持有假规则，以及谁是凶手',
      players,
      suspectList: room.caseData.suspects
    });
    
    // 人机自动指控
    startBotAccusations(room, roomId);
  }

  function startBotAccusations(room, roomId) {
    const allPlayers = getPlayersList(room);
    const falseHolderIds = room.botAssignments
      .filter(a => a.hasFalse)
      .map(a => a.botId)
      .concat(room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId));
    
    room.botAssignments.forEach((assignment, index) => {
      const delay = 2000 + Math.random() * 3000;
      const timer = setTimeout(() => {
        if (room.phase === 'accusation') {
          const botInfo = room.bots.get(assignment.botId);
          const { falsePlayerId, murdererGuess } = botMakeAccusation(
            assignment.rules,
            allPlayers.filter(p => p.id !== assignment.botId),
            falseHolderIds.filter(id => id !== assignment.botId),
            room.caseData.suspects
          );
          
          room.accusations.push({
            playerId: assignment.botId,
            nickname: botInfo.nickname,
            falsePlayerId,
            murdererGuess
          });
          
          io.to(roomId).emit('accusationUpdate', {
            submitted: room.accusations.length,
            total: room.totalPlayers
          });
          
          if (room.accusations.length === room.totalPlayers) {
            calculateResults(room, roomId);
          }
        }
      }, delay);
      room.botTimers.push(timer);
    });
  }

  socket.on('submitAccusation', ({ roomId, falsePlayerId, murdererGuess }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'accusation') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    
    room.accusations.push({
      playerId: socket.id,
      nickname: player.nickname,
      falsePlayerId,
      murdererGuess
    });
    
    io.to(roomId).emit('accusationUpdate', {
      submitted: room.accusations.length,
      total: room.totalPlayers
    });
    
    if (room.accusations.length === room.totalPlayers) {
      calculateResults(room, roomId);
    }
  });

  function calculateResults(room, roomId) {
    clearBotTimers(room);
    const caseData = room.caseData;
    const realMurderer = caseData.murderer;
    const falseHolders = room.playerAssignments.filter(a => a.hasFalse).map(a => a.playerId)
      .concat(room.botAssignments.filter(a => a.hasFalse).map(a => a.botId));
    
    const results = [];
    let goodScore = 0;
    let badScore = 0;
    
    for (const acc of room.accusations) {
      const guessedFalseCorrect = falseHolders.includes(acc.falsePlayerId);
      const guessedMurdererCorrect = (acc.murdererGuess === realMurderer);
      const isFalseHolder = falseHolders.includes(acc.playerId);
      
      results.push({
        nickname: acc.nickname,
        guessedFalsePlayer: (room.players.get(acc.falsePlayerId) || room.bots.get(acc.falsePlayerId))?.nickname || '未知',
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
    
    const allPlayerRules = [];
    room.playerAssignments.forEach(a => {
      const player = room.players.get(a.playerId);
      allPlayerRules.push({
        nickname: player?.nickname || '未知',
        hasFalse: a.hasFalse,
        rules: a.rules.map(r => ({ rule: r.rule, isTrue: r.isTrue }))
      });
    });
    room.botAssignments.forEach(a => {
      const bot = room.bots.get(a.botId);
      allPlayerRules.push({
        nickname: bot?.nickname || '未知',
        hasFalse: a.hasFalse,
        rules: a.rules.map(r => ({ rule: r.rule, isTrue: r.isTrue }))
      });
    });
    
    const winner = goodScore >= badScore ? '正方（推理者）' : '反方（误导者）';
    room.phase = 'result';
    
    io.to(roomId).emit('gameResult', {
      results,
      falseHolders: falseHolders.map(id => (room.players.get(id) || room.bots.get(id))?.nickname),
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
    clearBotTimers(room);
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

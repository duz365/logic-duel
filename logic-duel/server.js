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
const MODEL = 'Pro/deepseek-ai/DeepSeek-V3.1-Terminus';
const MAX_DISCUSS_TIME = 10 * 60 * 1000;
const API_TIMEOUT = 20000;

console.log('========================================');
console.log('服务器启动中...');
console.log('API_KEY 存在:', !!API_KEY);
console.log('模型:', MODEL);
console.log('========================================');

const rooms = new Map();
const matchQueue = [];

function tryMatch() {
  if (matchQueue.length >= 2) {
    const player1 = matchQueue.shift();
    const player2 = matchQueue.shift();
    const roomId = generateRoomId();
    rooms.set(roomId, {
      players: new Map(), bots: new Map(), host: player1.socket.id, phase: 'lobby',
      caseData: null, playerAssignments: [], botAssignments: [],
      statements: [], accusations: [], discussReady: new Set(), botTimers: [],
      totalPlayers: 0, statementSubmitted: new Set(), botMemories: new Map()
    });
    const room = rooms.get(roomId);
    room.players.set(player1.socket.id, { nickname: player1.nickname, isBot: false });
    player1.socket.join(roomId);
    player1.socket.emit('matchSuccess', { roomId, playerId: player1.socket.id, players: getPlayersList(room), phase: 'lobby', isHost: true, message: '匹配成功！你是房主。' });
    room.players.set(player2.socket.id, { nickname: player2.nickname, isBot: false });
    player2.socket.join(roomId);
    player2.socket.emit('matchSuccess', { roomId, playerId: player2.socket.id, players: getPlayersList(room), phase: 'lobby', isHost: false, message: '匹配成功！等待房主开始。' });
    io.to(roomId).emit('playerListUpdate', getPlayersList(room));
    console.log(`匹配: ${player1.nickname} & ${player2.nickname} → ${roomId}`);
    if (matchQueue.length >= 2) tryMatch();
  }
}

function generateRoomId() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function generateBotId() { return 'bot_' + Math.random().toString(36).substring(2, 8); }

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

// ==================== AI 生成案件（强化版 + 自我验证） ====================
async function generateCase(playerCount) {
  const { totalRules, trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`\n===== AI生成案件 ===== 玩家:${playerCount} 总规则:${totalRules} 真:${trueCount} 假:${falseCount}`);
  
  if (!API_KEY) throw new Error('API_KEY未配置');

  const genPrompt = `你是逻辑谜题大师。生成一个严谨推理案件。输出纯JSON。

核心约束：
- 嫌疑人3个，中文名随机创造（禁止张三李四王五等常见名）
- 严格生成${totalRules}条规则，其中${trueCount}条真规则、${falseCount}条假规则
- 每条≤18字，简洁陈述句
- 用全部${trueCount}条真规则必须能唯一推出凶手，移除任何一条都无法确定
- 每条真规则都是必要条件，不能用"排除法"绕过
- 假规则与真规则形成微妙矛盾，但不是直接否定
- 案例描述中直接写出嫌疑人名字

{"caseTitle":"≤8字","caseDescription":"嫌疑人XX、YY和ZZ...≤40字","suspects":["名1","名2","名3"],"murderer":"凶手名","trueRules":[""...严格${trueCount}条],"falseRules":[""...严格${falseCount}条],"reasoning":"用全部真规则逐步推导出凶手的完整逻辑链，≤100字"}`;

  let caseData = null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: genPrompt }], temperature: 0.95, max_tokens: 2000 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) {
        const data = await response.json();
        let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const p = JSON.parse(content);
        if (p.caseTitle && p.murderer && p.trueRules?.length === trueCount && p.falseRules?.length === falseCount && p.suspects?.length === 3) {
          caseData = {
            caseTitle: p.caseTitle,
            caseDescription: p.caseDescription || '',
            suspects: p.suspects,
            murderer: p.murderer,
            trueRules: p.trueRules,
            falseRules: p.falseRules,
            reasoning: p.reasoning || ''
          };
          console.log('生成成功:', caseData.caseTitle);
          break;
        }
        console.log(`规则数量不符: 真${p.trueRules?.length}/${trueCount} 假${p.falseRules?.length}/${falseCount}`);
      }
    } catch (e) { console.error('生成失败:', e.message); }
  }

  if (!caseData) throw new Error('AI案件生成失败');

  // 自我验证
  console.log('自我验证中...');
  const verifyPrompt = `验证推理案件是否严谨。
嫌疑人：${caseData.suspects.join('、')}
凶手：${caseData.murderer}
真规则（${trueCount}条）：${caseData.trueRules.map((r,i)=>(i+1)+'.'+r).join('；')}

回答：
1. 用全部${trueCount}条真规则能否唯一推出凶手是"${caseData.murderer}"？
2. 移除任意一条后还能确定凶手吗？
3. 第1问"是"且第2问"否"，回复"验证通过"。否则指出问题。`;

  let verified = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: verifyPrompt }], temperature: 0.1, max_tokens: 100 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) {
        const data = await response.json();
        const result = data.choices[0].message.content.trim();
        if (result.includes('验证通过')) { verified = true; console.log('✅ 验证通过'); break; }
        else console.log('验证未通过:', result.substring(0, 50));
      }
    } catch (e) {}
  }

  if (!verified) {
    console.log('验证失败，重新生成...');
    return await generateCase(playerCount);
  }

  return caseData;
}

function shuffleArray(arr) { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function assignRules(trueRules, falseRules, totalPlayers) {
  const shuffledTrue=shuffleArray(trueRules), shuffledFalse=shuffleArray(falseRules);
  const falseHolderIndices=shuffleArray([...Array(totalPlayers).keys()]).slice(0,shuffledFalse.length);
  const assignments=[]; let trueIndex=0, falseIndex=0;
  for(let i=0;i<totalPlayers;i++){const playerRules=[];if(falseHolderIndices.includes(i)&&falseIndex<shuffledFalse.length){playerRules.push({rule:shuffledFalse[falseIndex],isTrue:false});falseIndex++;playerRules.push({rule:shuffledTrue[trueIndex],isTrue:true});trueIndex++;}else{playerRules.push({rule:shuffledTrue[trueIndex],isTrue:true});trueIndex++;playerRules.push({rule:shuffledTrue[trueIndex],isTrue:true});trueIndex++;}assignments.push({playerIndex:i,playerRules,hasFalse:falseHolderIndices.includes(i)});}
  return assignments;
}

function getBotName(index) { const names=['侦探小王','推理达人','逻辑怪','福尔摩斯猫','机智老张','观察者小李']; return names[index%names.length]; }
function botSelectStatement(botRules) { const trueRules=botRules.filter(r=>r.isTrue); if(trueRules.length>0)return trueRules[Math.floor(Math.random()*trueRules.length)].rule; return botRules[Math.floor(Math.random()*botRules.length)].rule; }

function cleanBotReply(reply, hasFalse) {
  if(!reply)return''; reply=reply.replace(/["'""''「」『』]/g,'').trim();
  const cc=(reply.match(/[\u4e00-\u9fa5]/g)||[]).length, lc=(reply.match(/[a-zA-Z]/g)||[]).length;
  if(lc>reply.length*0.3||cc<3){const f=hasFalse?["我记不太清了。","那不重要吧。"]:["线索指向很明显。","让我再想想。"];return f[Math.floor(Math.random()*f.length)];}
  reply=reply.replace(/\b[a-zA-Z]+\b/g,'').replace(/\s+/g,' ').trim();
  if(reply.length<3||!/[\u4e00-\u9fa5]/.test(reply)){const f=hasFalse?["我记不太清了。","那不重要吧。"]:["线索指向很明显。","让我再想想。"];return f[Math.floor(Math.random()*f.length)];}
  return reply;
}

async function compressForMemory(text) {
  if (!API_KEY) return text.substring(0, 30);
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`}, body:JSON.stringify({ model:MODEL, messages:[{role:'user',content:`摘要到15字："${text}"`}], temperature:0.1, max_tokens:30 }), signal:c.signal });
    clearTimeout(t); const d = await r.json();
    return d.choices[0].message.content.trim() || text.substring(0, 20);
  } catch (e) { return text.substring(0, 20); }
}

async function generateBotDiscussionLine(botName, botRules, hasFalse, statements, suspects, caseDescription, memory) {
  if (!API_KEY) return hasFalse ? "我觉得没那么简单。" : "关键线索出现了。";
  const myTrueRules = botRules.filter(r=>r.isTrue).map(r=>r.rule);
  const myFalseRule = botRules.find(r=>!r.isTrue);
  const st = statements.map(s => `${s.nickname}:"${s.rule}"`).join(';');
  const wc = hasFalse ? "你是扰乱者。可以撒谎但不能被识破。不能和已公开的任何规则矛盾，也不能和你自己的真规则矛盾。" : "你是推理者。分析矛盾帮大家。";
  const memText = memory?.length > 0 ? `历史:${memory.join(';')}` : '';
  const myRuleInfo = hasFalse ? `你的真规则:${myTrueRules.join(';')}。你的假规则:${myFalseRule?.rule||''}。` : `你的规则:${myTrueRules.join(';')}。`;
  const prompt = `"${botName}"。案件:${caseDescription}。嫌疑人:${suspects.join(',')}。${myRuleInfo}公开:${st}。${memText}${wc}纯中文发言≤20字。`;
  for (let a=0;a<3;a++){try{const c=new AbortController();const t=setTimeout(()=>c.abort(),10000);const r=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`},body:JSON.stringify({model:MODEL,messages:[{role:'user',content:prompt}],temperature:0.95,max_tokens:60}),signal:c.signal});clearTimeout(t);const d=await r.json();let line=d.choices[0].message.content.trim();line=cleanBotReply(line,hasFalse);if(line&&line.length>=3)return line;}catch(e){}}
  return hasFalse?"别想太多。":"这条线索重要。";
}

async function generateBotReply(botName, botRules, hasFalse, statements, suspects, caseDescription, playerMessage, memory) {
  if (!API_KEY) return hasFalse ? "我不太确定。" : "线索指向很明显。";
  const myTrueRules = botRules.filter(r=>r.isTrue).map(r=>r.rule);
  const myFalseRule = botRules.find(r=>!r.isTrue);
  const ar = botRules.map(r=>r.rule);
  const ur = ar.filter(r=>!statements.some(s=>s.rule===r));
  const st = statements.map(s=>`${s.nickname}:"${s.rule}"`).join(';');
  const ia = /规则|线索|另一条|还有什么|告诉我|你知道|你掌握|你的/.test(playerMessage);
  let ri = '';
  if (ia && ur.length > 0) {
    if (hasFalse) {
      ri = `你是扰乱者。你的真规则:${myTrueRules.join(';')}。假规则:${myFalseRule?.rule||''}。如果被问未公开规则，可以撒谎编造，但不能和已公开规则矛盾，也不能和你的真规则矛盾。`;
    } else {
      ri = `你是推理者，必须诚实。未公开规则:"${ur.join('"、"')}"。被问就如实说出。`;
    }
  }
  const wc = hasFalse ? "扰乱者。撒谎不被发现。不能和自己真规则或已公开规则矛盾。" : "推理者。诚实回答。";
  const memText = memory?.length > 0 ? `历史:${memory.join(';')}` : '';
  const myRuleInfo = hasFalse ? `真规则:${myTrueRules.join(';')}。假规则:${myFalseRule?.rule||''}。` : `规则:${myTrueRules.join(';')}。`;
  const prompt = `"${botName}"。${myRuleInfo}未公开:${ur.join(';')}。公开:${st}。${ri}${wc}${memText}有人说:"${playerMessage}"。纯中文回复15-25字。`;
  for (let a=0;a<3;a++){try{const c=new AbortController();const t=setTimeout(()=>c.abort(),8000);const r=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`},body:JSON.stringify({model:MODEL,messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:80}),signal:c.signal});clearTimeout(t);const d=await r.json();let reply=d.choices[0].message.content.trim();reply=cleanBotReply(reply,hasFalse);if(reply&&reply.length>=3)return reply;}catch(e){}}
  if(ia&&ur.length>0&&!hasFalse)return ur[Math.floor(Math.random()*ur.length)];
  return hasFalse?"我记不太清了。":"线索指向很明显。";
}

function botMakeAccusation(botRules,players,falseHolderCandidates,suspects,hasFalse){const fc=Math.max(1,falseHolderCandidates.length);let g=[];if(hasFalse){const w=players.filter(p=>!falseHolderCandidates.includes(p.id));for(let i=0;i<fc;i++){if(w.length>0)g.push(w.splice(Math.floor(Math.random()*w.length),1)[0].id);}}else{const c=[...falseHolderCandidates];for(let i=0;i<fc;i++){if(c.length>0&&Math.random()<0.6)g.push(c.splice(Math.floor(Math.random()*c.length),1)[0]);else{const o=players.filter(p=>!g.includes(p.id));if(o.length>0)g.push(o[Math.floor(Math.random()*o.length)].id);}}}return{falsePlayerIds:[...new Set(g)].slice(0,fc),murdererGuess:suspects[Math.floor(Math.random()*suspects.length)]};}

// ==================== Socket ====================
io.on('connection',(socket)=>{
  console.log('连接:',socket.id);

  socket.on('startMatch',({nickname})=>{if(!nickname)return;if(matchQueue.find(p=>p.socket.id===socket.id)){socket.emit('matchStatus',{status:'waiting',message:'正在匹配中...'});return;}matchQueue.push({socket,nickname});socket.emit('matchStatus',{status:'waiting',message:'寻找对手...'});tryMatch();});
  socket.on('cancelMatch',()=>{const i=matchQueue.findIndex(p=>p.socket.id===socket.id);if(i!==-1){matchQueue.splice(i,1)[0];socket.emit('matchStatus',{status:'cancelled',message:'已取消'});}});

  socket.on('joinRoom',({nickname,roomId})=>{if(!nickname)return;const rid=roomId||generateRoomId();if(!rooms.has(rid)){rooms.set(rid,{players:new Map(),bots:new Map(),host:socket.id,phase:'lobby',caseData:null,playerAssignments:[],botAssignments:[],statements:[],accusations:[],discussReady:new Set(),botTimers:[],totalPlayers:0,statementSubmitted:new Set(),botMemories:new Map()});}const room=rooms.get(rid);room.players.set(socket.id,{nickname,isBot:false});socket.join(rid);socket.emit('roomJoined',{roomId:rid,playerId:socket.id,players:getPlayersList(room),phase:room.phase,isHost:room.host===socket.id});io.to(rid).emit('playerListUpdate',getPlayersList(room));});

  socket.on('addBots',({roomId,count})=>{const room=rooms.get(roomId);if(!room||room.host!==socket.id||room.phase!=='lobby')return;for(let i=0;i<count;i++)room.bots.set(generateBotId(),{nickname:getBotName(room.bots.size+i),isBot:true});io.to(roomId).emit('playerListUpdate',getPlayersList(room));});
  socket.on('removeBots',({roomId})=>{const room=rooms.get(roomId);if(!room||room.host!==socket.id||room.phase!=='lobby')return;room.bots.clear();room.botMemories.clear();io.to(roomId).emit('playerListUpdate',getPlayersList(room));});

  socket.on('startGame',async({roomId})=>{const room=rooms.get(roomId);if(!room||room.host!==socket.id)return;const tp=room.players.size+room.bots.size;if(tp<2){socket.emit('errorMessage','至少2人');return;}room.totalPlayers=tp;room.phase='preparing';room.statementSubmitted=new Set();io.to(roomId).emit('phaseChange',{phase:'preparing',message:'AI生成并验证案件中...'});try{room.caseData=await generateCase(tp);}catch(e){socket.emit('errorMessage','案件生成失败，请重试');room.phase='lobby';return;}const{falseCount}=getRuleCounts(tp);const as=assignRules(room.caseData.trueRules,room.caseData.falseRules,tp);const pids=Array.from(room.players.keys());room.playerAssignments=[];for(let i=0;i<pids.length;i++)room.playerAssignments.push({playerId:pids[i],rules:as[i].playerRules,hasFalse:as[i].hasFalse});const bids=Array.from(room.bots.keys());room.botAssignments=[];for(let i=0;i<bids.length;i++)room.botAssignments.push({botId:bids[i],rules:as[pids.length+i].playerRules,hasFalse:as[pids.length+i].hasFalse});room.botMemories.clear();bids.forEach(bid=>room.botMemories.set(bid,[]));room.phase='reading';room.statements=[];room.accusations=[];room.discussReady=new Set();io.to(roomId).emit('phaseChange',{phase:'reading',message:'查看规则',totalPlayers:tp,falseCount});for(const a of room.playerAssignments){const ps=io.sockets.sockets.get(a.playerId);if(ps)ps.emit('yourRules',{rules:a.rules,hasFalseRule:a.hasFalse,caseTitle:room.caseData.caseTitle,caseDescription:room.caseData.caseDescription,suspects:room.caseData.suspects});}room.botAssignments.forEach((a)=>{const timer=setTimeout(()=>{if(room.phase==='reading'){room.discussReady.add(a.botId);io.to(roomId).emit('readyProgress',{ready:room.discussReady.size,total:tp});if(room.discussReady.size===tp){room.phase='statement';room.discussReady.clear();room.statements=[];room.statementSubmitted=new Set();io.to(roomId).emit('phaseChange',{phase:'statement',message:'陈述阶段',totalPlayers:tp,falseCount});startBotStatements(room,roomId);}}},2000+Math.random()*3000);room.botTimers.push(timer);});});

  function startBotStatements(room,roomId){room.botAssignments.forEach((a)=>{const timer=setTimeout(()=>{if(room.phase==='statement'){const rule=botSelectStatement(a.rules);room.statements.push({playerId:a.botId,nickname:room.bots.get(a.botId).nickname,rule});room.statementSubmitted.add(a.botId);io.to(roomId).emit('statementSubmitProgress',{submitted:room.statementSubmitted.size,total:room.totalPlayers});if(room.statementSubmitted.size===room.totalPlayers)revealStatements(room,roomId);}},3000+Math.random()*4000);room.botTimers.push(timer);});}
  function revealStatements(room,roomId){io.to(roomId).emit('statementsRevealed',room.statements);setTimeout(()=>{room.phase='discuss';room.discussReady.clear();io.to(roomId).emit('phaseChange',{phase:'discuss',message:'讨论',statements:room.statements,suspectList:room.caseData.suspects,totalPlayers:room.totalPlayers,falseCount:getRuleCounts(room.totalPlayers).falseCount});startBotDiscussion(room,roomId);setTimeout(()=>{if(room.phase==='discuss')io.to(roomId).emit('discussTimeout');},MAX_DISCUSS_TIME);},2000);}
  function startBotDiscussion(room,roomId){room.botAssignments.forEach((a)=>{const count=1+Math.floor(Math.random()*2);for(let i=0;i<count;i++){const timer=setTimeout(async()=>{if(room.phase==='discuss'){const bi=room.bots.get(a.botId);const mem=room.botMemories.get(a.botId)||[];const line=await generateBotDiscussionLine(bi.nickname,a.rules,a.hasFalse,room.statements,room.caseData.suspects,room.caseData.caseDescription,mem);io.to(roomId).emit('chatMessage',{from:bi.nickname,message:line});const compressed=await compressForMemory(line);mem.push(compressed);if(mem.length>10)mem.shift();}},8000+i*15000+Math.random()*8000);room.botTimers.push(timer);}});}
  function startBotReadyToAccusation(room,roomId){room.botAssignments.forEach((a)=>{const timer=setTimeout(()=>{if(room.phase==='discuss'){room.discussReady.add(a.botId);io.to(roomId).emit('readyProgress',{ready:room.discussReady.size,total:room.totalPlayers});if(room.discussReady.size===room.totalPlayers)startAccusationPhase(room,roomId);}},3000+Math.random()*5000);room.botTimers.push(timer);});}
  function clearBotTimers(room){room.botTimers.forEach(t=>clearTimeout(t));room.botTimers=[];}

  socket.on('chatMessage',({roomId,message})=>{const room=rooms.get(roomId);if(!room||room.phase!=='discuss')return;const player=room.players.get(socket.id);if(!player)return;io.to(roomId).emit('chatMessage',{from:player.nickname,message});room.bots.forEach(async(bi,bid)=>{if(message.includes(bi.nickname)){const ba=room.botAssignments.find(a=>a.botId===bid);if(!ba)return;setTimeout(async()=>{if(room.phase==='discuss'){const mem=room.botMemories.get(bid)||[];const reply=await generateBotReply(bi.nickname,ba.rules,ba.hasFalse,room.statements,room.caseData.suspects,room.caseData.caseDescription,message,mem);io.to(roomId).emit('chatMessage',{from:bi.nickname,message:reply});const cm=await compressForMemory(`玩家:${message}`);const cr=await compressForMemory(reply);mem.push(cm,cr);if(mem.length>10)mem.splice(0,2);}},2000+Math.random()*3000);}});});

  socket.on('readyToStatement',({roomId})=>{const room=rooms.get(roomId);if(!room||room.phase!=='reading')return;room.discussReady.add(socket.id);io.to(roomId).emit('readyProgress',{ready:room.discussReady.size,total:room.totalPlayers});if(room.discussReady.size===room.totalPlayers){room.phase='statement';room.discussReady.clear();room.statements=[];room.statementSubmitted=new Set();io.to(roomId).emit('phaseChange',{phase:'statement',message:'陈述阶段',totalPlayers:room.totalPlayers,falseCount:getRuleCounts(room.totalPlayers).falseCount});startBotStatements(room,roomId);}});
  socket.on('submitStatement',({roomId,rule})=>{const room=rooms.get(roomId);if(!room||room.phase!=='statement')return;const player=room.players.get(socket.id);if(!player)return;room.statements.push({playerId:socket.id,nickname:player.nickname,rule});room.statementSubmitted.add(socket.id);io.to(roomId).emit('statementSubmitProgress',{submitted:room.statementSubmitted.size,total:room.totalPlayers});if(room.statementSubmitted.size===room.totalPlayers)revealStatements(room,roomId);});
  socket.on('readyToAccusation',({roomId})=>{const room=rooms.get(roomId);if(!room||room.phase!=='discuss')return;room.discussReady.add(socket.id);io.to(roomId).emit('readyProgress',{ready:room.discussReady.size,total:room.totalPlayers});if(room.discussReady.size===1)startBotReadyToAccusation(room,roomId);if(room.discussReady.size===room.totalPlayers)startAccusationPhase(room,roomId);});
  socket.on('forceAccusation',({roomId})=>{const room=rooms.get(roomId);if(!room||room.host!==socket.id||room.phase!=='discuss')return;clearBotTimers(room);startAccusationPhase(room,roomId);});

  function startAccusationPhase(room,roomId){clearBotTimers(room);room.phase='accusation';room.accusations=[];const{falseCount}=getRuleCounts(room.totalPlayers);io.to(roomId).emit('phaseChange',{phase:'accusation',message:'指控',players:getPlayersList(room),suspectList:room.caseData.suspects,totalPlayers:room.totalPlayers,falseCount});startBotAccusations(room,roomId);}
  function startBotAccusations(room,roomId){const ap=getPlayersList(room);const fi=room.botAssignments.filter(a=>a.hasFalse).map(a=>a.botId).concat(room.playerAssignments.filter(a=>a.hasFalse).map(a=>a.playerId));room.botAssignments.forEach((a)=>{const timer=setTimeout(()=>{if(room.phase==='accusation'){const{falsePlayerIds,murdererGuess}=botMakeAccusation(a.rules,ap.filter(p=>p.id!==a.botId),fi.filter(id=>id!==a.botId),room.caseData.suspects,a.hasFalse);room.accusations.push({playerId:a.botId,nickname:room.bots.get(a.botId).nickname,falsePlayerIds,murdererGuess,isBot:true});io.to(roomId).emit('accusationUpdate',{submitted:room.accusations.length,total:room.totalPlayers});if(room.accusations.length===room.totalPlayers)revealAccusations(room,roomId);}},2000+Math.random()*3000);room.botTimers.push(timer);});}
  function revealAccusations(room,roomId){const fv={},mv={};room.accusations.forEach(a=>{(a.falsePlayerIds||[]).forEach(id=>{const n=(room.players.get(id)||room.bots.get(id))?.nickname||'?';fv[n]=(fv[n]||0)+1;});mv[a.murdererGuess]=(mv[a.murdererGuess]||0)+1;});const maj=Math.floor(room.totalPlayers/2)+1;io.to(roomId).emit('accusationsRevealed',{falseVotes:fv,murdererVotes:mv,totalPlayers:room.totalPlayers,majority:maj});setTimeout(()=>calcResults(room,roomId,fv,mv,maj),3000);}
  socket.on('submitAccusation',({roomId,falsePlayerIds,murdererGuess})=>{const room=rooms.get(roomId);if(!room||room.phase!=='accusation')return;const player=room.players.get(socket.id);if(!player)return;room.accusations.push({playerId:socket.id,nickname:player.nickname,falsePlayerIds,murdererGuess,isBot:false});io.to(roomId).emit('accusationUpdate',{submitted:room.accusations.length,total:room.totalPlayers});if(room.accusations.length===room.totalPlayers)revealAccusations(room,roomId);});

  function calcResults(room,roomId,fv,mv,maj){
    clearBotTimers(room);
    const realM=room.caseData.murderer;
    const falseHolders=room.playerAssignments.filter(a=>a.hasFalse).map(a=>a.playerId).concat(room.botAssignments.filter(a=>a.hasFalse).map(a=>a.botId));
    const correctFH=falseHolders.map(id=>(room.players.get(id)||room.bots.get(id))?.nickname).filter(Boolean);
    const falseCount=correctFH.length;
    let correctCount=0,missedCount=0;
    for(const name of correctFH){if((fv[name]||0)>=maj)correctCount++;else missedCount++;}
    const falseGoodScore=correctCount,falseBadScore=missedCount;
    const topM=Object.entries(mv).sort((a,b)=>b[1]-a[1])[0]?.[0];
    const mOk=topM===realM&&(mv[topM]||0)>=maj;
    const murdererGoodScore=mOk?1:0,murdererBadScore=mOk?0:1;
    const goodScore=falseGoodScore+murdererGoodScore,badScore=falseBadScore+murdererBadScore;
    const vd=room.accusations.map(a=>({nickname:a.nickname,votedFalsePlayer:(a.falsePlayerIds||[]).map(id=>(room.players.get(id)||room.bots.get(id))?.nickname||'?').join(', '),votedMurderer:a.murdererGuess,isBot:a.isBot||false}));
    const apr=[];room.playerAssignments.forEach(a=>{const p=room.players.get(a.playerId);apr.push({nickname:p?.nickname||'?',hasFalse:a.hasFalse,rules:a.rules.map(r=>({rule:r.rule,isTrue:r.isTrue}))});});room.botAssignments.forEach(a=>{const b=room.bots.get(a.botId);apr.push({nickname:b?.nickname||'?',hasFalse:a.hasFalse,rules:a.rules.map(r=>({rule:r.rule,isTrue:r.isTrue}))});});
    room.phase='result';
    io.to(roomId).emit('gameResult',{falseHolders:correctFH,realMurderer:realM,goodScore,badScore,winner:goodScore>=badScore?'正方（推理者）':'反方（扰乱者）',reasoning:room.caseData.reasoning,caseTitle:room.caseData.caseTitle,allPlayerRules:apr,falseVotes:fv,murdererVotes:mv,majority:maj,falseCorrect:falseGoodScore,murdererCorrect:mOk,voteDetails:vd,correctCount,wrongCount:0,missedCount,falseCount});
    room.caseData=null;room.playerAssignments=[];room.botAssignments=[];room.statements=[];room.accusations=[];room.discussReady=new Set();room.statementSubmitted=new Set();room.totalPlayers=0;room.botMemories.clear();
  }

  socket.on('returnToLobby',({roomId})=>{const room=rooms.get(roomId);if(!room)return;room.phase='lobby';room.caseData=null;room.playerAssignments=[];room.botAssignments=[];room.statements=[];room.accusations=[];room.discussReady=new Set();room.statementSubmitted=new Set();room.totalPlayers=0;room.botMemories.clear();clearBotTimers(room);socket.emit('roomJoined',{roomId,playerId:socket.id,players:getPlayersList(room),phase:'lobby',isHost:room.host===socket.id});io.to(roomId).emit('playerListUpdate',getPlayersList(room));io.to(roomId).emit('phaseChange',{phase:'lobby',message:'等待房主开始...'});});
  socket.on('leaveRoom',({roomId})=>handleLeave(socket,roomId));
  socket.on('disconnect',()=>{const qi=matchQueue.findIndex(p=>p.socket.id===socket.id);if(qi!==-1)matchQueue.splice(qi,1);for(const[rid,room]of rooms.entries()){if(room.players.has(socket.id)){handleLeave(socket,rid);break;}}});

  function handleLeave(socket,roomId){const room=rooms.get(roomId);if(!room)return;clearBotTimers(room);room.players.delete(socket.id);room.discussReady.delete(socket.id);socket.leave(roomId);if(room.players.size===0){rooms.delete(roomId);return;}if(room.host===socket.id)room.host=room.players.keys().next().value;io.to(roomId).emit('playerListUpdate',getPlayersList(room));}
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n✅ 端口 ${PORT}`));

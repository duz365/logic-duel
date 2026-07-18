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
const MODEL = 'Qwen/Qwen2.5-14B-Instruct';
const MAX_DISCUSS_TIME = 10 * 60 * 1000;
const API_TIMEOUT = 15000;

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
      totalPlayers: 0, statementSubmitted: new Set()
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

// ==================== 内置案件库 ====================
function getBuiltInCase(trueCount, falseCount) {
  const cases = [
    {
      caseTitle: "画室命案", caseDescription: "画家在画室被杀。嫌疑人：阿明、红姐、小美。",
      suspects: ["阿明", "红姐", "小美"], murderer: "红姐",
      trueRules: ["阿明和红姐案发时都在画室","小美案发时在楼下被多人看到","凶器是调色刀","红姐手上有颜料痕迹","阿明和死者当天发生过争吵","小美和死者无过节","调色刀上有红姐指纹","阿明有小美的不在场证明","死者手机最后通话是红姐","画室钥匙只有三人有"],
      falseRules: ["小美案发时无人看到","凶器上没有指纹","阿明没有画室钥匙"],
      reasoning: "小美有不在场证明排除。阿明和小美互相作证排除。红姐有颜料痕迹+调色刀指纹+最后通话记录。"
    },
    {
      caseTitle: "密室中毒", caseDescription: "程序员在封闭办公室中毒身亡。嫌疑人：大刘、小杨、郑总。",
      suspects: ["大刘", "小杨", "郑总"], murderer: "大刘",
      trueRules: ["毒在咖啡中15分钟发作","大刘案发前15分钟递过咖啡","小杨案发时在楼下餐厅","郑总案发时在开会","只有大刘和死者会煮咖啡","小杨有餐厅监控证明","郑总有10人会议证明","大刘和死者有项目矛盾","死者电脑被格式化","大刘是唯一知道密码的人"],
      falseRules: ["小杨案发时不在餐厅","毒药1分钟发作","郑总没有会议证明"],
      reasoning: "小杨郑总都有不在场证明。咖啡只有大刘和死者会煮。大刘递咖啡时间吻合。电脑格式化+知道密码=动机。"
    },
    {
      caseTitle: "珠宝失窃", caseDescription: "珠宝店夜间被盗。嫌疑人：店员小林、保安老周、经理陈姐。",
      suspects: ["小林", "老周", "陈姐"], murderer: "老周",
      trueRules: ["报警器在凌晨2点被关闭","老周是当晚值班保安","小林当晚有不在场证明","陈姐的钥匙在保险柜中","保险柜需要密码和钥匙同时打开","老周知道保险柜密码","小林不知道密码","陈姐当晚在外地出差","监控在凌晨1点55分被切断","老周有监控室的钥匙"],
      falseRules: ["小林当晚没有不在场证明","陈姐的钥匙不在保险柜","监控当晚正常工作"],
      reasoning: "小林有不在场证明+不知道密码排除。陈姐在外地+钥匙在保险柜排除。老周值班+知道密码+有监控室钥匙+切断监控时间吻合。"
    },
    {
      caseTitle: "游轮坠海", caseDescription: "富商在游轮上坠海身亡。嫌疑人：妻子沈姐、助手小马、船长阿海。",
      suspects: ["沈姐", "小马", "阿海"], murderer: "沈姐",
      trueRules: ["死者坠海前喝过酒","沈姐在晚餐时给死者倒酒","小马晚餐时在餐厅有监控","阿海晚餐时在驾驶舱有记录","死者体内有安眠药","沈姐有安眠药处方","小马不知道安眠药的存在","阿海不接触死者饮食","死者救生衣被人割破","沈姐当晚去过死者房间"],
      falseRules: ["小马晚餐时不在餐厅","死者体内没有安眠药","阿海接触过死者饮食"],
      reasoning: "小马有监控证明+不知道安眠药排除。阿海不接触饮食+有驾驶舱记录排除。沈姐倒酒+有安眠药+去过房间+救生衣被破坏。"
    }
  ];
  const c = cases[Math.floor(Math.random() * cases.length)];
  return {
    caseTitle: c.caseTitle, caseDescription: c.caseDescription,
    suspects: c.suspects, murderer: c.murderer,
    trueRules: c.trueRules.slice(0, trueCount),
    falseRules: c.falseRules.slice(0, falseCount),
    reasoning: c.reasoning
  };
}

// ==================== AI 生成案件 ====================
async function generateCase(playerCount) {
  const { trueCount, falseCount } = getRuleCounts(playerCount);
  console.log(`\n===== AI生成案件 ===== 玩家:${playerCount} 真:${trueCount} 假:${falseCount}`);
  
  if (!API_KEY) {
    console.log('无API_KEY，使用内置案件');
    return getBuiltInCase(trueCount, falseCount);
  }

  const prompt = `生成推理案件。纯JSON。嫌疑人随机中文名。${trueCount}条真规则，${falseCount}条假规则。每条≤18字。真规则合起来唯一指向凶手。{"caseTitle":"","caseDescription":"","suspects":["","",""],"murderer":"","trueRules":[],"falseRules":[],"reasoning":""}`;

  try {
    console.log('调用API...');
    const controller = new AbortController();
    const timeout = setTimeout(() => { console.log('超时，中止'); controller.abort(); }, API_TIMEOUT);

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    console.log('响应状态:', response.status);

    if (response.ok) {
      const data = await response.json();
      let content = data.choices[0].message.content;
      content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const p = JSON.parse(content);
      if (p.caseTitle && p.murderer && p.trueRules?.length >= trueCount && p.falseRules?.length >= falseCount) {
        console.log('✅', p.caseTitle);
        return {
          caseTitle: p.caseTitle, caseDescription: p.caseDescription || '',
          suspects: p.suspects, murderer: p.murderer,
          trueRules: p.trueRules.slice(0, trueCount),
          falseRules: p.falseRules.slice(0, falseCount),
          reasoning: p.reasoning || ''
        };
      }
    }
    const errorBody = await response.text();
    console.error('API失败:', response.status, errorBody.substring(0, 200));
  } catch (e) {
    console.error('异常:', e.message);
  }

  console.log('使用内置案件');
  return getBuiltInCase(trueCount, falseCount);
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

function manualCompress(text){if(!text)return'';text=text.replace(/["'""'']/g,'').replace(/\s+/g,' ').trim();const ps=['。','！','？','，','；','、','：'];for(const p of ps){const i=text.indexOf(p);if(i>4&&i<=22)return text.substring(0,i+1);}if(text.length>20){const s=text.substring(0,20);const l=s.lastIndexOf(' ');return l>4?s.substring(0,l):s;}return text;}

async function compressReply(longReply,botName){if(!API_KEY)return manualCompress(longReply);const prompt=`精简到20字以内。\n"${longReply}"`;for(let a=0;a<5;a++){try{const c=new AbortController();const t=setTimeout(()=>c.abort(),5000);const r=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`},body:JSON.stringify({model:'Qwen/Qwen2.5-7B-Instruct',messages:[{role:'user',content:prompt}],temperature:0.2,max_tokens:40}),signal:c.signal});clearTimeout(t);const d=await r.json();let compressed=d.choices[0].message.content.trim();compressed=cleanBotReply(compressed,false);if(compressed&&compressed.length>=3&&compressed.length<=25)return compressed;if(compressed.length>25)return await compressReply(compressed,botName);}catch(e){}}return manualCompress(longReply);}

async function generateBotDiscussionLine(botName,botRules,hasFalse,statements,suspects,caseDescription){if(!API_KEY)return hasFalse?"我觉得没那么简单。":"关键线索出现了。";const mr=botRules.map(r=>`(${r.isTrue?'真':'假'})${r.rule}`).join(';');const st=statements.map(s=>`${s.nickname}:"${s.rule}"`).join(';');const wc=hasFalse?"误导大家，可以撒谎。":"找出真相，分析矛盾。";const prompt=`你是"${botName}"。案件:${caseDescription}。嫌疑人:${suspects.join(',')}。规则:${mr}。公开:${st}。${wc}纯中文发言≤20字。`;for(let a=0;a<3;a++){try{const c=new AbortController();const t=setTimeout(()=>c.abort(),10000);const r=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`},body:JSON.stringify({model:'Qwen/Qwen2.5-7B-Instruct',messages:[{role:'user',content:prompt}],temperature:0.95,max_tokens:60}),signal:c.signal});clearTimeout(t);const d=await r.json();let line=d.choices[0].message.content.trim();line=cleanBotReply(line,hasFalse);if(line&&line.length>=3){if(line.length>25)line=await compressReply(line,botName);return line;}}catch(e){}}return hasFalse?"别想太多。":"这条线索重要。";}

async function generateBotReply(botName,botRules,hasFalse,statements,suspects,caseDescription,playerMessage){if(!API_KEY){const l=hasFalse?["我不太确定。","我记不太清了。"]:["线索指向很明显。","关键证据已经有了。"];return l[Math.floor(Math.random()*l.length)];}const ar=botRules.map(r=>r.rule);const ur=ar.filter(r=>!statements.some(s=>s.rule===r));const st=statements.map(s=>`${s.nickname}:"${s.rule}"`).join(';');const ia=/规则|线索|另一条|还有什么|告诉我|你知道|你掌握|你的/.test(playerMessage);let ri='';if(ia&&ur.length>0){if(hasFalse){const fo=[`"${suspects[Math.floor(Math.random()*suspects.length)]}在案发时有不在场证明"`,`"现场没有找到任何可疑物品"`,`"监控显示一切正常"`,`"死者没有挣扎痕迹"`];ri=`你是扰乱者，可以撒谎。比如：${fo[Math.floor(Math.random()*fo.length)]}。`;}else{const rr=ur[Math.floor(Math.random()*ur.length)];ri=`你是推理者，必须诚实。未公开:"${ur.join('"、"')}"。如实说出，比如："${rr}"。`;}}const wc=hasFalse?"扰乱者。误导，可撒谎。":"推理者。诚实，帮推理。";const prompt=`"${botName}"。案件:${caseDescription}。公开:${st}。未公开:${ur.join(';')||'无'}。${ri}${wc}有人说:"${playerMessage}"。纯中文回复15-25字。`;for(let a=0;a<3;a++){try{const c=new AbortController();const t=setTimeout(()=>c.abort(),8000);const r=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`},body:JSON.stringify({model:'Qwen/Qwen2.5-7B-Instruct',messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:80}),signal:c.signal});clearTimeout(t);const d=await r.json();let reply=d.choices[0].message.content.trim();reply=cleanBotReply(reply,hasFalse);if(reply&&reply.length>=3){if(reply.length>30)reply=await compressReply(reply,botName);return reply;}}catch(e){}}if(ia&&ur.length>0&&!hasFalse)return ur[Math.floor(Math.random()*ur.length)];return hasFalse?"我记不太清了。":"线索指向很明显。";}

function botMakeAccusation(botRules,players,falseHolderCandidates,suspects,hasFalse){const fc=Math.max(1,falseHolderCandidates.length);let g=[];if(hasFalse){const w=players.filter(p=>!falseHolderCandidates.includes(p.id));for(let i=0;i<fc;i++){if(w.length>0)g.push(w.splice(Math.floor(Math.random()*w.length),1)[0].id);}}else{const c=[...falseHolderCandidates];for(let i=0;i<fc;i++){if(c.length>0&&Math.random()<0.6)g.push(c.splice(Math.floor(Math.random()*c.length),1)[0]);else{const o=players.filter(p=>!g.includes(p.id));if(o.length>0)g.push(o[Math.floor(Math.random()*o.length)].id);}}}return{falsePlayerIds:[...new Set(g)].slice(0,fc),murdererGuess:suspects[Math.floor(Math.random()*suspects.length)]};}

// ==================== Socket ====================
io.on('connection',(socket)=>{
  console.log('连接:',socket.id);

  socket.on('startMatch',({nickname})=>{if(!nickname)return;if(matchQueue.find(p=>p.socket.id===socket.id)){socket.emit('matchStatus',{status:'waiting',message:'正在匹配中...'});return;}matchQueue.push({socket,nickname});console.log(`${nickname} 加入匹配队列，长度:${matchQueue.length}`);socket.emit('matchStatus',{status:'waiting',message:'寻找对手...'});tryMatch();});
  socket.on('cancelMatch',()=>{const i=matchQueue.findIndex(p=>p.socket.id===socket.id);if(i!==-1){const p=matchQueue.splice(i,1)[0];console.log(`${p.nickname} 取消匹配`);socket.emit('matchStatus',{status:'cancelled',message:'已取消'});}});

  socket.on('joinRoom',({nickname,roomId})=>{if(!nickname)return;const rid=roomId||generateRoomId();if(!rooms.has(rid)){rooms.set(rid,{players:new Map(),bots:new Map(),host:socket.id,phase:'lobby',caseData:null,playerAssignments:[],botAssignments:[],statements:[],accusations:[],discussReady:new Set(),botTimers:[],totalPlayers:0,statementSubmitted:new Set()});}const room=rooms.get(rid);room.players.set(socket.id,{nickname,isBot:false});socket.join(rid);socket.emit('roomJoined',{roomId:rid,playerId:socket.id,players:getPlayersList(room),phase:room.phase,isHost:room.host===socket.id});io.to(rid).emit('playerListUpdate',getPlayersList(room));});

  socket.on('addBots',({roomId,count})=>{const room=rooms.get(roomId);if(!room||room.host!==socket.id||room.phase!=='lobby')return;for(let i=0;i<count;i++)room.bots.set(generateBotId(),{nickname:getBotName(room.bots.size+i),isBot:true});io.to(roomId).emit('playerListUpdate',getPlayersList(room));});
  socket.on('removeBots',({roomId})=>{const room=rooms.get(roomId);if(!room||room.host!==socket.id||room.phase!=='lobby')return;room.bots.clear();io.to(roomId).emit('playerListUpdate',getPlayersList(room));});

  socket.on('startGame',async({roomId})=>{const room=rooms.get(roomId);if(!room||room.host!==socket.id)return;const tp=room.players.size+room.bots.size;if(tp<2){socket.emit('errorMessage','至少2人');return;}room.totalPlayers=tp;room.phase='preparing';room.statementSubmitted=new Set();io.to(roomId).emit('phaseChange',{phase:'preparing',message:'准备案件...'});const{falseCount}=getRuleCounts(tp);room.caseData=await generateCase(tp);const as=assignRules(room.caseData.trueRules,room.caseData.falseRules,tp);const pids=Array.from(room.players.keys());room.playerAssignments=[];for(let i=0;i<pids.length;i++)room.playerAssignments.push({playerId:pids[i],rules:as[i].playerRules,hasFalse:as[i].hasFalse});const bids=Array.from(room.bots.keys());room.botAssignments=[];for(let i=0;i<bids.length;i++)room.botAssignments.push({botId:bids[i],rules:as[pids.length+i].playerRules,hasFalse:as[pids.length+i].hasFalse});room.phase='reading';room.statements=[];room.accusations=[];room.discussReady=new Set();io.to(roomId).emit('phaseChange',{phase:'reading',message:'查看规则',totalPlayers:tp,falseCount});for(const a of room.playerAssignments){const ps=io.sockets.sockets.get(a.playerId);if(ps)ps.emit('yourRules',{rules:a.rules,hasFalseRule:a.hasFalse,caseTitle:room.caseData.caseTitle,caseDescription:room.caseData.caseDescription,suspects:room.caseData.suspects});}room.botAssignments.forEach((a)=>{const timer=setTimeout(()=>{if(room.phase==='reading'){room.discussReady.add(a.botId);io.to(roomId).emit('readyProgress',{ready:room.discussReady.size,total:tp});if(room.discussReady.size===tp){room.phase='statement';room.discussReady.clear();room.statements=[];room.statementSubmitted=new Set();io.to(roomId).emit('phaseChange',{phase:'statement',message:'陈述阶段',totalPlayers:tp,falseCount});startBotStatements(room,roomId);}}},2000+Math.random()*3000);room.botTimers.push(timer);});});

  function startBotStatements(room,roomId){room.botAssignments.forEach((a)=>{const timer=setTimeout(()=>{if(room.phase==='statement'){const rule=botSelectStatement(a.rules);room.statements.push({playerId:a.botId,nickname:room.bots.get(a.botId).nickname,rule});room.statementSubmitted.add(a.botId);io.to(roomId).emit('statementSubmitProgress',{submitted:room.statementSubmitted.size,total:room.totalPlayers});if(room.statementSubmitted.size===room.totalPlayers)revealStatements(room,roomId);}},3000+Math.random()*4000);room.botTimers.push(timer);});}
  function revealStatements(room,roomId){io.to(roomId).emit('statementsRevealed',room.statements);setTimeout(()=>{room.phase='discuss';room.discussReady.clear();io.to(roomId).emit('phaseChange',{phase:'discuss',message:'讨论',statements:room.statements,suspectList:room.caseData.suspects,totalPlayers:room.totalPlayers,falseCount:getRuleCounts(room.totalPlayers).falseCount});startBotDiscussion(room,roomId);setTimeout(()=>{if(room.phase==='discuss')io.to(roomId).emit('discussTimeout');},MAX_DISCUSS_TIME);},2000);}
  function startBotDiscussion(room,roomId){room.botAssignments.forEach((a)=>{const count=1+Math.floor(Math.random()*2);for(let i=0;i<count;i++){const timer=setTimeout(async()=>{if(room.phase==='discuss'){const bi=room.bots.get(a.botId);const line=await generateBotDiscussionLine(bi.nickname,a.rules,a.hasFalse,room.statements,room.caseData.suspects,room.caseData.caseDescription);io.to(roomId).emit('chatMessage',{from:bi.nickname,message:line});}},8000+i*15000+Math.random()*8000);room.botTimers.push(timer);}});}
  function startBotReadyToAccusation(room,roomId){room.botAssignments.forEach((a)=>{const timer=setTimeout(()=>{if(room.phase==='discuss'){room.discussReady.add(a.botId);io.to(roomId).emit('readyProgress',{ready:room.discussReady.size,total:room.totalPlayers});if(room.discussReady.size===room.totalPlayers)startAccusationPhase(room,roomId);}},3000+Math.random()*5000);room.botTimers.push(timer);});}
  function clearBotTimers(room){room.botTimers.forEach(t=>clearTimeout(t));room.botTimers=[];}

  socket.on('chatMessage',({roomId,message})=>{const room=rooms.get(roomId);if(!room||room.phase!=='discuss')return;const player=room.players.get(socket.id);if(!player)return;io.to(roomId).emit('chatMessage',{from:player.nickname,message});room.bots.forEach(async(bi,bid)=>{if(message.includes(bi.nickname)){const ba=room.botAssignments.find(a=>a.botId===bid);if(!ba)return;setTimeout(async()=>{if(room.phase==='discuss'){const reply=await generateBotReply(bi.nickname,ba.rules,ba.hasFalse,room.statements,room.caseData.suspects,room.caseData.caseDescription,message);io.to(roomId).emit('chatMessage',{from:bi.nickname,message:reply});}},2000+Math.random()*3000);}});});

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
    room.caseData=null;room.playerAssignments=[];room.botAssignments=[];room.statements=[];room.accusations=[];room.discussReady=new Set();room.statementSubmitted=new Set();room.totalPlayers=0;
  }

  socket.on('returnToLobby',({roomId})=>{const room=rooms.get(roomId);if(!room)return;room.phase='lobby';room.caseData=null;room.playerAssignments=[];room.botAssignments=[];room.statements=[];room.accusations=[];room.discussReady=new Set();room.statementSubmitted=new Set();room.totalPlayers=0;clearBotTimers(room);socket.emit('roomJoined',{roomId,playerId:socket.id,players:getPlayersList(room),phase:'lobby',isHost:room.host===socket.id});io.to(roomId).emit('playerListUpdate',getPlayersList(room));io.to(roomId).emit('phaseChange',{phase:'lobby',message:'等待房主开始...'});});
  socket.on('leaveRoom',({roomId})=>handleLeave(socket,roomId));
  socket.on('disconnect',()=>{const qi=matchQueue.findIndex(p=>p.socket.id===socket.id);if(qi!==-1)matchQueue.splice(qi,1);for(const[rid,room]of rooms.entries()){if(room.players.has(socket.id)){handleLeave(socket,rid);break;}}});

  function handleLeave(socket,roomId){const room=rooms.get(roomId);if(!room)return;clearBotTimers(room);room.players.delete(socket.id);room.discussReady.delete(socket.id);socket.leave(roomId);if(room.players.size===0){rooms.delete(roomId);return;}if(room.host===socket.id)room.host=room.players.keys().next().value;io.to(roomId).emit('playerListUpdate',getPlayersList(room));}
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n✅ 端口 ${PORT}`));

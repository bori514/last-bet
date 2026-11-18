
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 게임 화면(index.html) 제공
app.use(express.static(path.join(__dirname)));

// 메인 주소 접속 시 게임 화면 표시
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms=new Map(),UNIT=50000,START=2000000;
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const code=()=>Math.random().toString(36).slice(2,8).toUpperCase();
function active(r){return r.players.filter(p=>p.money>0&&!p.disconnected);}
function emit(r){for(const p of r.players){const visible=r.players.map(q=>({id:q.id,name:q.name,money:q.money,fold:q.fold,allin:q.allin,bet:q.bet,roundBet:q.roundBet,disconnected:q.disconnected,publicCard:q.id===p.id?null:q.publicCard,privateCard:q.id===p.id?q.privateCard:null,usedPublic:q.id===p.id?q.usedPublic:undefined,usedPrivate:q.id===p.id?q.usedPrivate:undefined}));io.to(p.id).emit('state',{code:r.code,host:r.host,phase:r.phase,round:r.round,pot:r.pot,currentBet:r.currentBet,turn:r.turn,players:visible,me:p.id,log:r.log.slice(-12),winners:r.winners,showdown:r.showdown,canStart:r.players.length>=3&&r.players.length<=6});}}
function log(r,msg){r.log.push(msg);if(r.log.length>100)r.log.shift();}
function pay(r,p,n){const amount=Math.min(n,p.money);p.money-=amount;p.bet+=amount;p.roundBet+=amount;r.pot+=amount;if(p.money===0)p.allin=true;return amount;}
function begin(r){r.round++;r.phase='bet';r.pot=0;r.currentBet=0;r.winners=[];r.showdown=[];r.acted=new Set();r.players.forEach(p=>{p.fold=p.money<=0||p.disconnected;p.allin=false;p.bet=0;p.roundBet=0;p.publicCard=null;p.privateCard=null;if(!p.fold){p.publicCard=p.publicDeck.pop();p.privateCard=p.privateDeck.pop();p.usedPublic.push(p.publicCard);p.usedPrivate.push(p.privateCard);pay(r,p,UNIT);}});r.turn=r.players.find(p=>!p.fold&&!p.allin)?.id||null;log(r,`라운드 ${r.round} 시작 · 참가비 50,000원`);if(!r.turn)settle(r);else emit(r);}
function eligible(r){return r.players.filter(p=>!p.fold&&!p.disconnected);}
function next(r){const contenders=eligible(r).filter(p=>!p.allin);if(eligible(r).length<=1||contenders.length===0||contenders.every(p=>r.acted.has(p.id)&&p.roundBet===r.currentBet)){settle(r);return;}const start=r.players.findIndex(p=>p.id===r.turn);for(let i=1;i<=r.players.length;i++){const p=r.players[(start+i)%r.players.length];if(!p.fold&&!p.allin&&!p.disconnected&&(!r.acted.has(p.id)||p.roundBet<r.currentBet)){r.turn=p.id;emit(r);return;}}settle(r);}
function settle(r){r.phase='result';r.turn=null;const alive=eligible(r);const best=Math.max(...alive.map(p=>p.publicCard+p.privateCard));const winners=alive.filter(p=>p.publicCard+p.privateCard===best);r.showdown=alive.map(p=>({id:p.id,publicCard:p.publicCard,privateCard:p.privateCard,sum:p.publicCard+p.privateCard}));if(winners.length){const share=Math.floor(r.pot/winners.length/UNIT)*UNIT;let remainder=r.pot-share*winners.length;winners.forEach((p,i)=>{p.money+=share+(i===0?remainder:0);});r.winners=winners.map(p=>p.id);log(r,`승자: ${winners.map(p=>p.name).join(', ')} · 합 ${best} · 팟 ${r.pot.toLocaleString()}원`);}else log(r,'승부 종료');if(r.round>=13||active(r).length<2){r.phase='finished';log(r,'게임 종료 · 최종 자본 순위 확정');}emit(r);}
function clean(s,max){return String(s||'').trim().slice(0,max);}
io.on('connection',socket=>{socket.on('create',({name},ack)=>{let c=code();while(rooms.has(c))c=code();const p={id:socket.id,name:clean(name,16)||'플레이어',money:START,disconnected:false};const r={code:c,host:p.id,players:[p],phase:'lobby',round:0,pot:0,currentBet:0,turn:null,log:[],winners:[],showdown:[]};rooms.set(c,r);socket.data.room=c;socket.join(c);ack?.({ok:true,code:c});emit(r);});socket.on('join',({code:c,name},ack)=>{c=clean(c,6).toUpperCase();const r=rooms.get(c);if(!r||r.phase!=='lobby'||r.players.length>=6){ack?.({error:'방이 없거나 이미 시작했거나 가득 찼습니다.'});return;}const p={id:socket.id,name:clean(name,16)||'플레이어',money:START,disconnected:false};r.players.push(p);socket.data.room=c;socket.join(c);ack?.({ok:true,code:c});log(r,`${p.name} 입장`);emit(r);});socket.on('start',()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=='lobby'||r.players.length<3)return;r.players.forEach(p=>{p.publicDeck=shuffle(Array.from({length:13},(_,i)=>i+1));p.privateDeck=shuffle(Array.from({length:13},(_,i)=>i+1));p.usedPublic=[];p.usedPrivate=[];});begin(r);});socket.on('action',({type,amount},ack)=>{const r=rooms.get(socket.data.room);if(!r||r.phase!=='bet'||r.turn!==socket.id)return ack?.({error:'지금은 내 차례가 아닙니다.'});const p=r.players.find(x=>x.id===socket.id);if(!p||p.fold||p.allin)return;const owed=Math.max(0,r.currentBet-p.roundBet);if(type==='fold'){p.fold=true;log(r,`${p.name}: 폴드`);}else if(type==='check'&&owed===0){log(r,`${p.name}: 체크`);}else if(type==='call'&&owed>0){pay(r,p,owed);log(r,`${p.name}: 콜`);}else if(type==='raise'){amount=Number(amount);if(!Number.isSafeInteger(amount)||amount<UNIT||amount%UNIT!==0||p.money<owed+amount)return ack?.({error:'레이즈 금액은 5만 원 단위이며 보유금 이내여야 합니다.'});pay(r,p,owed+amount);r.currentBet=p.roundBet;r.acted=new Set();log(r,`${p.name}: ${amount.toLocaleString()}원 레이즈`);}else return ack?.({error:'불가능한 행동입니다.'});r.acted.add(p.id);ack?.({ok:true});next(r);});socket.on('next',()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=='result')return;begin(r);});socket.on('disconnect',()=>{const r=rooms.get(socket.data.room);if(!r)return;const p=r.players.find(x=>x.id===socket.id);if(!p)return;if(r.phase==='lobby'){r.players=r.players.filter(x=>x.id!==socket.id);if(r.host===socket.id)r.host=r.players[0]?.id;if(!r.players.length){rooms.delete(r.code);return;}}else{p.disconnected=true;p.fold=true;if(r.phase==='bet'&&r.turn===socket.id){next(r);return;}}emit(r);});});
server.listen(process.env.PORT||3000,()=>console.log('13 THE LAST BET running on port '+(process.env.PORT||3000)));

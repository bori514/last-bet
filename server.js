
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UNIT = 50000;
const START = 2000000;
const MAX_ROUNDS = 13;

const rooms = new Map();

// 게임 화면 제공
// 서버 소스 파일은 공개하지 않음
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), err => {
    if (err && !res.headersSent) {
      res.status(500).send(
        'index.html 파일을 확인해주세요.'
      );
    }
  });
});

// public 폴더가 있는 경우 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));

function shuffle(arr) {
  const a = [...arr];

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

function makeCode() {
  let code;

  do {
    code = Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function log(room, message) {
  room.log.push(message);

  if (room.log.length > 100) {
    room.log.shift();
  }
}

function active(room) {
  return room.players.filter(
    p => p.money > 0 && !p.disconnected
  );
}

function eligible(room) {
  return room.players.filter(
    p => !p.fold && !p.disconnected
  );
}

// 플레이어별 카드 정보 분리
function emit(room) {
  for (const viewer of room.players) {
    const players = room.players.map(p => ({
      id: p.id,
      name: p.name,
      money: p.money,
      fold: p.fold,
      allin: p.allin,
      bet: p.bet,
      roundBet: p.roundBet,
      disconnected: p.disconnected,

      // 자신의 공개 카드는 볼 수 없음
      publicCard:
        p.id === viewer.id ? null : p.publicCard,

      // 자신의 비공개 카드만 볼 수 있음
      privateCard:
        p.id === viewer.id ? p.privateCard : null,

      usedPublic:
        p.id === viewer.id ? p.usedPublic : undefined,

      usedPrivate:
        p.id === viewer.id ? p.usedPrivate : undefined
    }));

    io.to(viewer.id).emit('state', {
      code: room.code,
      host: room.host,
      phase: room.phase,
      round: room.round,
      pot: room.pot,
      currentBet: room.currentBet,
      turn: room.turn,
      players,
      me: viewer.id,
      log: room.log.slice(-12),
      winners: room.winners,
      showdown: room.showdown,
      canStart:
        room.players.length >= 3 &&
        room.players.length <= 6
    });
  }
}

// 참가비 및 배팅 처리
function pay(room, player, amount) {
  const paid = Math.min(amount, player.money);

  player.money -= paid;
  player.bet += paid;
  player.roundBet += paid;
  room.pot += paid;

  if (player.money === 0) {
    player.allin = true;
  }

  return paid;
}

// 라운드 시작
function begin(room) {
  room.round++;
  room.phase = 'bet';
  room.pot = 0;
  room.currentBet = 0;
  room.winners = [];
  room.showdown = [];
  room.acted = new Set();

  for (const p of room.players) {
    p.fold = p.money <= 0 || p.disconnected;
    p.allin = false;
    p.bet = 0;
    p.roundBet = 0;
    p.publicCard = null;
    p.privateCard = null;

    if (!p.fold) {
      p.publicCard = p.publicDeck.pop();
      p.privateCard = p.privateDeck.pop();

      p.usedPublic.push(p.publicCard);
      p.usedPrivate.push(p.privateCard);

      pay(room, p, UNIT);
    }
  }

  const first = room.players.find(
    p => !p.fold && !p.allin
  );

  room.turn = first ? first.id : null;

  log(
    room,
    `라운드 ${room.round} 시작 · 참가비 50,000원`
  );

  if (!room.turn) {
    settle(room);
  } else {
    emit(room);
  }
}

// 다음 배팅 차례
function next(room) {
  const remaining = eligible(room);

  if (remaining.length <= 1) {
    settle(room);
    return;
  }

  const canAct = remaining.filter(p => !p.allin);

  if (
    canAct.length === 0 ||
    canAct.every(
      p =>
        room.acted.has(p.id) &&
        p.roundBet === room.currentBet
    )
  ) {
    settle(room);
    return;
  }

  const start = room.players.findIndex(
    p => p.id === room.turn
  );

  for (let i = 1; i <= room.players.length; i++) {
    const index =
      (start + i + room.players.length) %
      room.players.length;

    const p = room.players[index];

    if (
      !p.fold &&
      !p.allin &&
      !p.disconnected &&
      (
        !room.acted.has(p.id) ||
        p.roundBet < room.currentBet
      )
    ) {
      room.turn = p.id;
      emit(room);
      return;
    }
  }

  settle(room);
}

// 사이드 팟 정산
function distributePots(room, contenders) {
  const levels = [
    ...new Set(
      room.players
        .map(p => p.bet)
        .filter(n => n > 0)
    )
  ].sort((a, b) => a - b);

  let previous = 0;
  const winnerIds = new Set();

  for (const level of levels) {
    const contributors = room.players.filter(
      p => p.bet >= level
    );

    const amount =
      (level - previous) * contributors.length;

    previous = level;

    if (amount <= 0) continue;

    const candidates = contenders.filter(
      p => p.bet >= level
    );

    // 한 명만 남아 있는 경우에도 팟을 지급
    if (candidates.length === 0) {
      const fallback = contenders[0];

      if (fallback) {
        fallback.money += amount;
        winnerIds.add(fallback.id);
      }

      continue;
    }

    const best = Math.max(
      ...candidates.map(
        p => p.publicCard + p.privateCard
      )
    );

    const winners = candidates.filter(
      p => p.publicCard + p.privateCard === best
    );

    // 금액은 항상 5만 원 단위로 나누어 지급
    const units = Math.floor(amount / UNIT);
    const each = Math.floor(units / winners.length);
    const extra = units % winners.length;

    winners.forEach((p, i) => {
      const prize =
        (each + (i < extra ? 1 : 0)) * UNIT;

      p.money += prize;
      winnerIds.add(p.id);
    });

    const leftover = amount % UNIT;

    if (leftover > 0 && winners.length > 0) {
      winners[0].money += leftover;
    }
  }

  return [...winnerIds];
}

// 라운드 결과
function settle(room) {
  room.phase = 'result';
  room.turn = null;

  const contenders = eligible(room);

  room.showdown = contenders.map(p => ({
    id: p.id,
    publicCard: p.publicCard,
    privateCard: p.privateCard,
    sum: p.publicCard + p.privateCard
  }));

  if (contenders.length > 0) {
    room.winners = distributePots(room, contenders);

    const names = room.players
      .filter(p => room.winners.includes(p.id))
      .map(p => p.name);

    log(
      room,
      `승자: ${names.join(', ')} · 팟 ${room.pot.toLocaleString()}원`
    );
  } else {
    // 모든 플레이어가 연결 해제된 예외 상황
    log(room, '라운드 종료 · 참가자 없음');
  }

  if (
    room.round >= MAX_ROUNDS ||
    active(room).length < 2
  ) {
    room.phase = 'finished';

    log(
      room,
      '게임 종료 · 최종 자본 순위 확정'
    );
  }

  emit(room);
}

// 온라인 연결
io.on('connection', socket => {

  // 새 방 생성
  socket.on('create', (data = {}, ack) => {
    if (socket.data.room) {
      return ack?.({
        error: '이미 방에 참가 중입니다.'
      });
    }

    const roomCode = makeCode();

    const player = {
      id: socket.id,
      name: clean(data.name, 16) || '플레이어',
      money: START,
      disconnected: false
    };

    const room = {
      code: roomCode,
      host: player.id,
      players: [player],
      phase: 'lobby',
      round: 0,
      pot: 0,
      currentBet: 0,
      turn: null,
      log: [],
      winners: [],
      showdown: []
    };

    rooms.set(roomCode, room);

    socket.data.room = roomCode;
    socket.join(roomCode);

    ack?.({
      ok: true,
      code: roomCode
    });

    emit(room);
  });

  // 방 코드로 입장
  socket.on('join', (data = {}, ack) => {
    if (socket.data.room) {
      return ack?.({
        error: '이미 방에 참가 중입니다.'
      });
    }

    const roomCode = clean(
      data.code, 6
    ).toUpperCase();

    const room = rooms.get(roomCode);

    if (
      !room ||
      room.phase !== 'lobby' ||
      room.players.length >= 6
    ) {
      return ack?.({
        error:
          '방이 없거나 이미 시작했거나 가득 찼습니다.'
      });
    }

    const player = {
      id: socket.id,
      name: clean(data.name, 16) || '플레이어',
      money: START,
      disconnected: false
    };

    room.players.push(player);

    socket.data.room = roomCode;
    socket.join(roomCode);

    log(room, `${player.name} 입장`);

    ack?.({
      ok: true,
      code: roomCode
    });

    emit(room);
  });

  // 게임 시작
  socket.on('start', () => {
    const room = rooms.get(socket.data.room);

    if (
      !room ||
      room.host !== socket.id ||
      room.phase !== 'lobby' ||
      room.players.length < 3 ||
      room.players.length > 6
    ) {
      return;
    }

    for (const p of room.players) {
      p.publicDeck = shuffle(
        Array.from(
          { length: 13 },
          (_, i) => i + 1
        )
      );

      p.privateDeck = shuffle(
        Array.from(
          { length: 13 },
          (_, i) => i + 1
        )
      );

      p.usedPublic = [];
      p.usedPrivate = [];
    }

    begin(room);
  });

  // 배팅
  socket.on('action', (data = {}, ack) => {
    const room = rooms.get(socket.data.room);

    if (
      !room ||
      room.phase !== 'bet' ||
      room.turn !== socket.id
    ) {
      return ack?.({
        error: '지금은 내 차례가 아닙니다.'
      });
    }

    const p = room.players.find(
      x => x.id === socket.id
    );

    if (!p || p.fold || p.allin) {
      return ack?.({
        error: '배팅할 수 없습니다.'
      });
    }

    const type = data.type;
    const owed = Math.max(
      0,
      room.currentBet - p.roundBet
    );

    if (type === 'fold') {
      p.fold = true;

      log(room, `${p.name}: 폴드`);

    } else if (type === 'check') {
      if (owed !== 0) {
        return ack?.({
          error: '체크할 수 없습니다.'
        });
      }

      log(room, `${p.name}: 체크`);

    } else if (type === 'call') {
      if (owed <= 0) {
        return ack?.({
          error: '콜할 금액이 없습니다.'
        });
      }

      const paid = pay(room, p, owed);

      log(
        room,
        `${p.name}: ${paid.toLocaleString()}원 콜`
      );

    } else if (type === 'raise') {
      const amount = Number(data.amount);

      if (
        !Number.isSafeInteger(amount) ||
        amount < UNIT ||
        amount % UNIT !== 0 ||
        p.money < owed + amount
      ) {
        return ack?.({
          error:
            '레이즈는 5만 원 단위이며 보유금 이내여야 합니다.'
        });
      }

      pay(room, p, owed + amount);

      room.currentBet = p.roundBet;
      room.acted = new Set();

      log(
        room,
        `${p.name}: ${amount.toLocaleString()}원 레이즈`
      );

    } else if (type === 'allin') {
      const amount = p.money;

      if (amount <= 0) {
        return ack?.({
          error: '올인할 금액이 없습니다.'
        });
      }

      pay(room, p, amount);

      if (p.roundBet > room.currentBet) {
        room.currentBet = p.roundBet;
        room.acted = new Set();
      }

      log(room, `${p.name}: 올인`);

    } else {
      return ack?.({
        error: '불가능한 행동입니다.'
      });
    }

    room.acted.add(p.id);

    ack?.({ ok: true });

    next(room);
  });

  // 다음 라운드
  socket.on('next', () => {
    const room = rooms.get(socket.data.room);

    if (
      !room ||
      room.host !== socket.id ||
      room.phase !== 'result'
    ) {
      return;
    }

    begin(room);
  });

  // 접속 종료
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room);

    if (!room) return;

    const p = room.players.find(
      x => x.id === socket.id
    );

    if (!p) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter(
        x => x.id !== socket.id
      );

      if (room.host === socket.id) {
        room.host = room.players[0]?.id;
      }

      if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
      }

    } else {
      p.disconnected = true;
      p.fold = true;

      if (
        room.phase === 'bet' &&
        room.turn === socket.id
      ) {
        next(room);
        return;
      }
    }

    emit(room);
  });
});

// 서버 실행
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `13 THE LAST BET running on port ${PORT}`
  );
});

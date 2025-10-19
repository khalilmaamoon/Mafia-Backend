const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

let gameState = {
  players: {},
  round: 0,
  phase: 'lobby',
  timeLeft: 0,
  votes: {},
};

const gameCode = 'XYZ123';
const adminKey = 'admin123';
let timerInterval = null;

app.get('/game/state', (req, res) => {
  res.json({ gameCode, ...gameState });
});

app.post('/admin/remove', (req, res) => {
  const { playerId, adminKey: key } = req.body;
  if (key !== adminKey) return res.status(403).json({ error: 'Unauthorized' });
  if (gameState.players[playerId]) {
    gameState.players[playerId].status = 'eliminated';
    io.to(gameCode).emit('player:removed', playerId);
    res.json({ message: 'Player removed' });
  } else {
    res.status(404).json({ error: 'Player not found' });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id, 'Total connections:', io.engine.clientsCount);
  socket.emit('test', 'Connection successful');

  socket.on('join', ({ name }) => {
    console.log('Received join:', name, 'socket.id:', socket.id);
    if (!gameState.players[socket.id] || gameState.players[socket.id].name !== name) {
      gameState.players[socket.id] = { name, status: 'active' };
      socket.join(gameCode);
      console.log('Player added:', gameState.players);
      console.log('Socket joined room:', gameCode, 'Rooms:', socket.rooms);
      io.to(gameCode).emit('game:state', gameState);
      socket.emit('game:state', gameState); // Ensure joining client gets state
      console.log('Emitted game:state to room', gameCode, 'and socket', socket.id, 'players:', gameState.players);
    } else {
      console.log('Player already exists:', socket.id, gameState.players[socket.id]);
      socket.emit('game:state', gameState); // Send state to existing player
    }
  });

  socket.on('start', ({ key }) => {
    console.log('Start game requested with key:', key);
    if (key !== adminKey) return;
    gameState.players = Object.fromEntries(
      Object.entries(gameState.players).filter(([id, player]) => player.status === 'active')
    );
    gameState.phase = 'discussion';
    gameState.round = 1;
    io.to(gameCode).emit('game:state', gameState);
    startDiscussion();
  });

  socket.on('chat', ({ message }) => {
    if (gameState.players[socket.id]?.status === 'active') {
      io.to(gameCode).emit('chat', {
        player: gameState.players[socket.id].name,
        message,
      });
    }
  });

  socket.on('vote', ({ target }) => {
    if (gameState.phase === 'voting' && gameState.players[socket.id]?.status === 'active') {
      gameState.votes[socket.id] = target;
      io.to(gameCode).emit('game:state', gameState);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id, 'Total connections:', io.engine.clientsCount);
    if (gameState.players[socket.id]) {
      delete gameState.players[socket.id];
      io.to(gameCode).emit('game:state', gameState);
    }
  });
});

function startDiscussion() {
  if (timerInterval) {
    console.log('Clearing existing timer');
    clearInterval(timerInterval);
  }
  console.log('Starting discussion, setting timeLeft to 180');
  gameState.timeLeft = 180;
  gameState.phase = 'discussion';
  gameState.votes = {};
  io.to(gameCode).emit('timer', gameState.timeLeft);
  io.to(gameCode).emit('game:state', gameState);

  timerInterval = setInterval(() => {
    console.log('Timer tick: timeLeft =', gameState.timeLeft);
    gameState.timeLeft--;
    io.to(gameCode).emit('timer', gameState.timeLeft);
    io.to(gameCode).emit('game:state', gameState);
    console.log('Emitted timer to room', gameCode, 'timeLeft:', gameState.timeLeft);
    if (gameState.timeLeft <= 0) {
      console.log('Discussion ended, starting voting');
      clearInterval(timerInterval);
      timerInterval = null;
      startVoting();
    }
  }, 1000);
}

function startVoting() {
  if (timerInterval) {
    console.log('Clearing existing timer');
    clearInterval(timerInterval);
  }
  console.log('Starting voting, setting timeLeft to 60');
  gameState.timeLeft = 60;
  gameState.phase = 'voting';
  io.to(gameCode).emit('timer', gameState.timeLeft);
  io.to(gameCode).emit('game:state', gameState);

  timerInterval = setInterval(() => {
    console.log('Timer tick: timeLeft =', gameState.timeLeft);
    gameState.timeLeft--;
    io.to(gameCode).emit('timer', gameState.timeLeft);
    console.log('Emitted timer to room', gameCode, 'timeLeft:', gameState.timeLeft);
    if (gameState.timeLeft <= 0) {
      console.log('Voting ended, processing votes');
      clearInterval(timerInterval);
      timerInterval = null;
      processVotes();
    }
  }, 1000);
}

function processVotes() {
  const voteCounts = Object.values(gameState.votes).reduce((acc, target) => {
    acc[target] = (acc[target] || 0) + 1;
    return acc;
  }, {});
  const activePlayers = Object.values(gameState.players).filter(p => p.status === 'active').length;
  const majority = Math.floor(activePlayers / 2) + 1;
  const eliminated = Object.keys(voteCounts).find(target => voteCounts[target] >= majority);

  if (eliminated && gameState.players[eliminated]) {
    gameState.players[eliminated].status = 'eliminated';
    io.to(gameCode).emit('player:removed', eliminated);
  } else {
    io.to(gameCode).emit('vote:result', 'No one was eliminated.');
  }

  gameState.votes = {};
  startDiscussion();
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
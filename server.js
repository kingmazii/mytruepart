const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = createServer(app);

// Configuration
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const allowedOrigins = process.env.NODE_ENV !== 'production'
  ? [FRONTEND_URL, 'http://localhost:3000']
  : [FRONTEND_URL];

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// MongoDB connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Session model
const sessionSchema = new mongoose.Schema({
  sessionId: String,
  players: [String],
  timer: Number,
  isAnonymous: Boolean,
  isGameMode: Boolean,
  topics: [String],
  ratings: [{ rater: String, target: String, topic: String, rating: Number }],
  phase: String,
  online: [String],
  playerTokens: { type: Map, of: String },
  timerStarted: Boolean,
  startTime: Number
});
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

// Socket.io handlers
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('createSession', async (data) => {
    try {
      const { players, timer, isAnonymous, isGameMode, topics } = data;
      
      // Validation
      if (!players || !Array.isArray(players) {
        socket.emit('error', { message: 'Invalid player data' });
        return;
      }

      if (isAnonymous && players.length < 4) {
        socket.emit('error', { message: 'Anonymous mode requires at least 4 players' });
        return;
      }
      
      if (players.length < 2) {
        socket.emit('error', { message: 'At least 2 players are required' });
        return;
      }

      const uniquePlayers = new Set(players.map(name => name.trim().toLowerCase()));
      if (uniquePlayers.size !== players.length) {
        socket.emit('error', { message: 'Each player must have a unique name' });
        return;
      }

      if (players.some(name => !name.trim())) {
        socket.emit('error', { message: 'Player names cannot be empty' });
        return;
      }

      if (!topics || !Array.isArray(topics) || topics.some(t => !t)) {
        socket.emit('error', { message: 'All topics must be filled' });
        return;
      }

      // Create session
      const sessionId = generateSessionId();
      const playerTokens = {};
      players.forEach(p => {
        playerTokens[p] = crypto.randomBytes(8).toString('hex');
      });

      const session = new Session({
        sessionId,
        players,
        timer,
        isAnonymous,
        isGameMode,
        topics,
        ratings: [],
        phase: 'waiting',
        online: [],
        playerTokens: new Map(Object.entries(playerTokens)),
        timerStarted: false,
        startTime: null
      });

      await session.save();

      const links = players.map(p => ({
        username: p,
        token: playerTokens[p],
        url: `${FRONTEND_URL}/#/rate/${sessionId}/${playerTokens[p]}`
      }));

      const adminLink = `${FRONTEND_URL}/#/rate/${sessionId}/admin`;
      socket.emit('sessionCreated', { sessionId, links, adminLink });
    } catch (err) {
      console.error('Create session error:', err);
      socket.emit('error', { message: 'Server error' });
    }
  });

  socket.on('joinSession', async ({ sessionId, token, isAdmin }) => {
    try {
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('error', { message: 'Session not found' });
        return;
      }

      if (isAdmin) {
        socket.join(sessionId);
        socket.emit('sessionData', {
          players: session.players,
          topics: session.topics,
          timer: session.timer,
          anonymous: session.isAnonymous,
          gameMode: session.isGameMode,
          phase: session.phase,
          timerStarted: session.timerStarted,
          startTime: session.startTime
        });
        return;
      }

      const playerTokens = session.playerTokens || new Map();
      const username = [...playerTokens.entries()].find(([_, t]) => t === token)?.[0];
      if (!username) {
        socket.emit('error', { message: 'Invalid or expired token' });
        return;
      }

      socket.join(sessionId);
      socket.username = username;

      socket.emit('sessionData', {
        username,
        players: session.players,
        topics: session.topics,
        timer: session.timer,
        anonymous: session.isAnonymous,
        gameMode: session.isGameMode,
        phase: session.phase,
        timerStarted: session.timerStarted,
        startTime: session.startTime
      });

      // Handle late joiners
      const submittedUsers = [...new Set(session.ratings.map(r => r.rater))];
      if (submittedUsers.length >= 3) {
        if (session.isAnonymous) {
          const playerRatings = session.ratings.filter(r => r.target === username);
          const topicAverages = {};
          session.topics.forEach(topic => {
            const ratingsForTopic = playerRatings
              .filter(r => r.topic === topic)
              .map(r => r.rating);
            const avg = ratingsForTopic.length
              ? ratingsForTopic.reduce((sum, r) => sum + r, 0) / ratingsForTopic.length
              : 0;
            topicAverages[topic] = avg;
          });
          socket.emit('allRatingsSubmitted', {
            username,
            isAnonymous: true,
            results: { topicAverages }
          });
        } else {
          socket.emit('allRatingsSubmitted', {
            isAnonymous: false,
            results: session.ratings
          });
        }
      }
    } catch (err) {
      console.error('Join session error:', err);
      socket.emit('error', { message: 'Server error' });
    }
  });

  socket.on('startTimer', async ({ sessionId }) => {
    try {
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('error', { message: 'Session not found' });
        return;
      }

      session.timerStarted = true;
      session.startTime = Date.now();
      await session.save();

      io.to(sessionId).emit('timerStarted', {
        timer: session.timer,
        startTime: session.startTime,
        timerStarted: true
      });

      // Timer expiration handler
      setTimeout(async () => {
        const updatedSession = await Session.findOne({ sessionId });
        if (!updatedSession) return;

        const submittedUsers = [...new Set(updatedSession.ratings.map(r => r.rater))];
        const players = updatedSession.players.filter(p => p !== 'admin');
        const unsubmitted = players.filter(p => !submittedUsers.includes(p));

        if (unsubmitted.length > 0 && updatedSession.phase !== 'results') {
          for (const username of unsubmitted) {
            const autoRatings = [];
            for (const target of players) {
              if (target !== username) {
                for (const topic of updatedSession.topics) {
                  const existingRating = updatedSession.ratings.find(
                    r => r.rater === username && r.target === target && r.topic === topic
                  );
                  if (!existingRating) {
                    autoRatings.push({
                      rater: username,
                      target,
                      topic,
                      rating: -1
                    });
                  }
                }
              }
            }
            updatedSession.ratings.push(...autoRatings);
          }
          await updatedSession.save();
          await emitResults(updatedSession, sessionId, io);
        }
      }, session.timer * 1000);
    } catch (err) {
      console.error('Timer error:', err);
      socket.emit('error', { message: 'Server error' });
    }
  });

  socket.on('submitRatings', async ({ sessionId, username, ratings }) => {
    try {
      const session = await Session.findOne({ sessionId });
      if (!session) {
        socket.emit('error', { message: 'Session not found' });
        return;
      }

      const newRatings = [];
      for (const target in ratings) {
        for (const topic in ratings[target]) {
          newRatings.push({
            rater: username,
            target,
            topic,
            rating: ratings[target][topic]
          });
        }
      }

      session.ratings = session.ratings.filter(r => r.rater !== username);
      session.ratings.push(...newRatings);
      await session.save();

      await emitResults(session, sessionId, io);
      io.to(sessionId).emit('ratingsUpdated', { username });
    } catch (err) {
      console.error('Submit ratings error:', err);
      socket.emit('error', { message: 'Server error' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Results emitter (now properly contained)
async function emitResults(session, sessionId, io) {
  const players = session.players.filter(p => p !== 'admin');
  const submittedUsers = [...new Set(session.ratings.map(r => r.rater))];
  
  // Check submission requirements
  if (session.isGameMode && submittedUsers.length < players.length) return;
  if (session.isAnonymous && submittedUsers.length < players.length) return;

  session.phase = 'results';
  await session.save();

  if (session.isAnonymous) {
    const results = {};
    players.forEach(player => {
      const playerRatings = session.ratings.filter(r => r.target === player);
      const topicAverages = {};
      session.topics.forEach(topic => {
        const ratingsForTopic = playerRatings.filter(r => r.topic === topic && r.rating !== -1);
        topicAverages[topic] = ratingsForTopic.length > 0
          ? ratingsForTopic.reduce((sum, r) => sum + r.rating, 0) / ratingsForTopic.length
          : 'No ratings';
      });
      results[player] = { topicAverages };
    });
    
    players.forEach(player => {
      io.to(sessionId).emit('allRatingsSubmitted', {
        username: player,
        isAnonymous: true,
        results: results[player]
      });
    });
  } else {
    io.to(sessionId).emit('allRatingsSubmitted', {
      isAnonymous: false,
      results: session.ratings
    });
  }
}

// Fallback route for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Server start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

function generateSessionId() {
  return Math.random().toString(36).substr(2, 9);
}

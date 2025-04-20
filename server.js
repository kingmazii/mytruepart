const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = createServer(app);

// CORS configuration
const allowedOrigins = [process.env.FRONTEND_URL];
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000');
}

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// MongoDB connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Session schema and model
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

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('createSession', async (data) => {
    try {
      const session = new Session({ ...data, sessionId: generateSessionId() });
      await session.save();
      socket.emit('sessionCreated', session);
    } catch (error) {
      console.error('Error creating session:', error);
      socket.emit('error', { message: 'Failed to create session' });
    }
  });

  socket.on('joinSession', (data) => {
    // Handle joining session
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const emitResults = async (session, sessionId, io) => {
  console.log('DEBUG: emitResults called', {
    sessionId,
    submitted: [...new Set(session.ratings.map(r => r.rater))].length,
    isAnonymous: session.isAnonymous,
    isGameMode: session.isGameMode
  });

  const players = session.players.filter(p => p !== 'admin');
  const submittedUsers = [...new Set(session.ratings.map(r => r.rater))];
  // Add your emitResults logic here, e.g.:
  // io.to(sessionId).emit('results', { players, submittedUsers });
};

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something went wrong!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function generateSessionId() {
  return Math.random().toString(36).substr(2, 9);
}
  
  // For game mode: wait for ALL players to submit before showing results
  if (session.isGameMode) {
    if (submittedUsers.length < players.length) {
      console.log('DEBUG: Waiting for all players to submit in game mode', {
        submitted: submittedUsers.length,
        total: players.length
      });
      return;
    }
  } 
  // For anonymous mode: wait for ALL players to submit before showing results
  else if (session.isAnonymous) {
    if (submittedUsers.length < players.length) {
      console.log('DEBUG: Waiting for all players to submit in anonymous mode', {
        submitted: submittedUsers.length,
        total: players.length
      });
      return;
    }
  }
  // For non-game mode public: show results for each player as they submit
  else {
    // In public mode, we'll emit results for the player who just submitted
    const lastSubmittedUser = submittedUsers[submittedUsers.length - 1];
    if (lastSubmittedUser) {
      console.log('DEBUG: Emitting results for player in public mode', lastSubmittedUser);
      
      // For public mode, emit results only to the player who submitted
      io.to(sessionId).emit('allRatingsSubmitted', {
        username: lastSubmittedUser,
        isAnonymous: false,
        results: session.ratings
      });
      
      // Don't change phase to results yet, as other players may still be rating
      return;
    }
  }

  // If we reach here, either:
  // 1. All players have submitted in game mode
  // 2. All players have submitted in anonymous mode
  session.phase = 'results';
  await session.save();
  console.log('DEBUG: Emitting results, mode:', session.isAnonymous ? 'anonymous' : 'public');
  
  if (session.isAnonymous) {
    const results = {};
    players.forEach(player => {
      const playerRatings = session.ratings.filter(r => r.target === player);
      const topicAverages = {};
      const skippedCounts = {};
      
      session.topics.forEach(topic => {
        const ratingsForTopic = playerRatings.filter(r => r.topic === topic);
        const validRatings = ratingsForTopic.filter(r => r.rating !== -1).map(r => r.rating); // Exclude -1 ratings
        const skippedCount = ratingsForTopic.filter(r => r.rating === -1).length;
        
        skippedCounts[topic] = skippedCount;
        
        if (validRatings.length > 0) {
          topicAverages[topic] = validRatings.reduce((sum, r) => sum + r, 0) / validRatings.length;
        } else {
          topicAverages[topic] = 'No ratings';
        }
      });

      // Calculate total average excluding skipped ratings
      const validAverages = Object.values(topicAverages).filter(avg => typeof avg === 'number');
      const totalAvg = validAverages.length > 0
        ? validAverages.reduce((sum, avg) => sum + avg, 0) / validAverages.length
        : '-'; // Show '-' if all topics are skipped
      
      results[player] = { 
        topicAverages, 
        totalAverage: totalAvg,
        skippedCounts
      };
    });
    
    players.forEach(player => {
      io.to(sessionId).emit('allRatingsSubmitted', {
        username: player,
        isAnonymous: true,
        results: results[player]
      });
    });
  } else {
    // Public mode: emit results to all players
    io.to(sessionId).emit('allRatingsSubmitted', {
      isAnonymous: false,
      results: session.ratings
    });
  }
};

io.on('connection', (socket) => {
  console.log('DEBUG: Client connected:', socket.id);

socket.on('createSession', async (data) => {
  console.log('DEBUG: Received createSession with data:', data);
  try {
    const { players, timer, isAnonymous, isGameMode, topics } = data;
    
    // Basic validation
    if (!players || !Array.isArray(players)) {
      socket.emit('error', { message: 'Invalid player data' });
      return;
    }

    // Validate minimum player count based on mode
    if (isAnonymous && players.length < 4) {
      socket.emit('error', { message: 'Anonymous mode requires at least 4 players' });
      return;
    }
    
    if (players.length < 2) {
      socket.emit('error', { message: 'At least 2 players are required' });
      return;
    }

    // Check for duplicate names
    const uniquePlayers = new Set(players.map(name => name.trim().toLowerCase()));
    if (uniquePlayers.size !== players.length) {
      socket.emit('error', { message: 'Each player must have a unique name' });
      return;
    }

    // Check for empty or whitespace-only names
    if (players.some(name => !name.trim())) {
      socket.emit('error', { message: 'Player names cannot be empty' });
      return;
    }

    if (!topics || !Array.isArray(topics) || topics.some(t => !t)) {
      socket.emit('error', { message: 'All topics must be filled' });
      return;
    }

    const sessionId = Math.random().toString(36).substring(2, 15);

    // Generate secure player tokens
    const crypto = require('crypto');
    const playerTokens = {};
    players.forEach(p => {
      playerTokens[p] = crypto.randomBytes(8).toString('hex');
    });

    console.log('DEBUG: Generated tokens:', playerTokens);

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
    console.log('DEBUG: Session saved to MongoDB:', { sessionId, playerTokens: JSON.stringify([...session.playerTokens]) });

    const links = players.map(p => ({
      username: p,
      token: playerTokens[p],
      url: `${FRONTEND_URL}/#/rate/${sessionId}/${playerTokens[p]}`
    }));

    const adminLink = `${FRONTEND_URL}/#/rate/${sessionId}/admin`;
    socket.emit('sessionCreated', { sessionId, links, adminLink });
  } catch (err) {
    console.error('DEBUG: createSession error:', err.message);
    socket.emit('error', { message: 'Server error' });
  }
});

socket.on('startTimer', async ({ sessionId }) => {
  console.log('DEBUG: startTimer:', sessionId);
  try {
    const session = await Session.findOne({ sessionId });
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    // Reset timer state
    session.timerStarted = true;
    session.startTime = Date.now();
    await session.save();

    const timerData = {
      timer: session.timer,
      startTime: session.startTime,
      timerStarted: true
    };

    console.log('DEBUG: Timer started/restarted for session:', sessionId, timerData);

    // Emit to all clients in the session
    io.to(sessionId).emit('timerStarted', timerData);

    // Also emit sessionData to ensure all clients are in sync
    io.to(sessionId).emit('sessionData', {
      ...timerData,
      phase: session.phase,
      players: session.players,
      topics: session.topics,
      anonymous: session.isAnonymous,
      gameMode: session.isGameMode
    });

    // Timer expiration logic
    setTimeout(async () => {
      const updatedSession = await Session.findOne({ sessionId });
      if (!updatedSession) return;

      const submittedUsers = [...new Set(updatedSession.ratings.map(r => r.rater))];
      const players = updatedSession.players.filter(p => p !== 'admin');
      const unsubmitted = players.filter(p => !submittedUsers.includes(p));

      if (unsubmitted.length > 0 && updatedSession.phase !== 'results') {
        console.log('DEBUG: Timer expired, auto-submitting for:', unsubmitted);
        
        // For each unsubmitted player, create ratings with -1 (skipped) for unrated topics
        for (const username of unsubmitted) {
          const autoRatings = [];
          for (const target of players) {
            if (target !== username) {
              for (const topic of updatedSession.topics) {
                // Check if this rating already exists
                const existingRating = updatedSession.ratings.find(
                  r => r.rater === username && r.target === target && r.topic === topic
                );
                
                if (!existingRating) {
                  autoRatings.push({
                    rater: username,
                    target,
                    topic,
                    rating: -1 // Mark as skipped
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
    }, session.timer * 1000); // Convert seconds to milliseconds
  } catch (error) {
    console.error('DEBUG: startTimer error:', error.message);
    socket.emit('error', { message: 'Server error' });
  }
});

socket.on('joinSession', async ({ sessionId, token, isAdmin }) => {
  console.log('DEBUG: joinSession received', { sessionId, token, isAdmin });

  const session = await Session.findOne({ sessionId });
  if (!session) {
    console.log('DEBUG: Session not found for sessionId:', sessionId);
    socket.emit('error', { message: 'Session not found' });
    return;
  }

  console.log('DEBUG: Session found, playerTokens:', JSON.stringify([...(session.playerTokens || new Map())], null, 2));

  if (isAdmin) {
    socket.join(sessionId);
    console.log('DEBUG: Admin joined session', sessionId);
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
  console.log('DEBUG: Token validation', { token, username });
  if (!username) {
    console.log('DEBUG: Token not found in playerTokens', { token });
    socket.emit('error', { message: 'Invalid or expired token' });
    return;
  }

  socket.join(sessionId);
  console.log('DEBUG: Player joined session', { sessionId, username });

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

  socket.username = username;

  const submittedUsers = [...new Set(session.ratings.map(r => r.rater))];
  if (submittedUsers.length >= 3 && !isAdmin) {
    console.log('DEBUG: Late joiner, sending results', { username });
    if (session.isAnonymous) {
      const playerRatings = session.ratings.filter(r => r.target === username);
      const topicAverages = {};
      session.topics.forEach(topic => {
        const ratingsForTopic = playerRatings
          .filter(r => r.topic === topic)
          .map(r => r.rating);
        const avg = ratingsForTopic.length
          ? (ratingsForTopic.reduce((sum, r) => sum + r, 0) / ratingsForTopic.length).toFixed(1)
          : 0;
        topicAverages[topic] = parseFloat(avg);
      });
      const totalAvg = session.topics.length
        ? (Object.values(topicAverages).reduce((sum, avg) => sum + parseFloat(avg), 0) / session.topics.length).toFixed(1)
        : 0;
      socket.emit('allRatingsSubmitted', {
        username,
        isAnonymous: true,
        results: { topicAverages, totalAverage: parseFloat(totalAvg) }
      });
    } else {
      socket.emit('allRatingsSubmitted', {
        isAnonymous: false,
        results: session.ratings
      });
    }
  }
});

socket.on('submitRatings', async ({ sessionId, username, ratings }) => {
  console.log('DEBUG: submitRatings:', sessionId, username, ratings);
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
    console.log('DEBUG: Ratings saved for', username);

    await emitResults(session, sessionId, io);

    io.to(sessionId).emit('ratingsUpdated', { username });
  } catch (error) {
    console.error('DEBUG: submitRatings error:', error.message);
    socket.emit('error', { message: 'Server error' });
  }
});

socket.on('getReport', async ({ sessionId, username, isAdmin }) => {
  console.log('DEBUG: getReport:', { sessionId, username, isAdmin });
  try {
    const session = await Session.findOne({ sessionId });
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }
    socket.emit('reportData', {
      players: session.players,
      topics: session.topics,
      ratings: session.ratings,
      isAnonymous: session.isAnonymous
    });
  } catch (err) {
    console.error('DEBUG: getReport error:', err.message);
    socket.emit('error', { message: 'Server error' });
  }
});

socket.on('disconnect', () => {
  console.log('DEBUG: Client disconnected:', socket.id);
});
});
const path = require('path');

// Serve static files from the frontend folder (adjust if needed)
app.use(express.static(path.join(__dirname, '../frontend')));

// Fallback route for SPA (handles React-style hash routing like #/link)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});
server.listen(PORT, '0.0.0.0', () => console.log(`DEBUG: Server on port ${PORT}`));

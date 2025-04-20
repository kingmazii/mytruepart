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

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, 'frontend')));

// Fallback route for SPA (handles React-style hash routing like #/link)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/index.html'));
});

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

// Wrap the main server code in an async function
async function startServer() {
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
    try {
      console.log('DEBUG: emitResults called', {
        sessionId,
        submitted: [...new Set(session.ratings.map(r => r.rater))].length,
        isAnonymous: session.isAnonymous,
        isGameMode: session.isGameMode
      });

      const players = session.players.filter(p => p !== 'admin');
      const submittedUsers = [...new Set(session.ratings.map(r => r.rater))];
      const lastSubmittedUser = submittedUsers[submittedUsers.length - 1];

      console.log('DEBUG: Emitting results for player in public mode', lastSubmittedUser);

      // Example: If updating session in MongoDB
      await Session.updateOne({ sessionId }, { $set: { phase: 'results' } });

      io.to(sessionId).emit('results', { players, submittedUsers, lastSubmittedUser });
    } catch (error) {
      console.error('Error in emitResults:', error);
    }
  };

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

function generateSessionId() {
  return Math.random().toString(36).substr(2, 9);
}

// Start the server
startServer().catch(err => {
  console.error('Error starting server:', err);
  process.exit(1);
});

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
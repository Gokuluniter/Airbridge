const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only specific file types
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'text/plain'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, PDF, and TXT files are allowed.'));
    }
  }
});

// Enable CORS for all routes - Must be before Socket.IO initialization
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// Initialize Socket.IO with proper configuration
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
  cookie: false,
  serveClient: true,
  allowUpgrades: true,
  perMessageDeflate: false,
  httpCompression: true,
  path: '/socket.io/',
  connectTimeout: 45000,
  maxHttpBufferSize: 1e8,
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Add error handling for Socket.IO
io.engine.on('connection_error', (err) => {
  console.error('Connection error:', err);
});

// Add connection stabilization
io.engine.on("headers", (headers, req) => {
  headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
  headers["Pragma"] = "no-cache";
  headers["Expires"] = "0";
});

// Add connection monitoring
io.engine.on("connection", (socket) => {
  console.log('New connection established:', socket.id);
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
  
  socket.on('close', (reason) => {
    console.log('Socket closed:', reason);
  });
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).send('Internal Server Error');
});

// Constants for limits
const MAX_ROOMS = 100;
const MAX_USERS_PER_ROOM = 10;
const MAX_TEXT_LENGTH = 50000;
const MAX_ROOM_ID_LENGTH = 50;

// Generate a unique room ID
function generateRoomId() {
  return uuidv4().slice(0, 8);
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

// Track rooms with additional metadata
const rooms = new Map();
const chatHistory = new Map(); // Store chat history for each room
const textContent = new Map(); // Store text content for each room
const userInfo = new Map();
const userRooms = new Map(); // Track which room each user is in

// Generate a random user name
function generateUserName() {
  const adjectives = ['Happy', 'Clever', 'Brave', 'Swift', 'Calm', 'Wise', 'Bright', 'Kind', 'Gentle', 'Smart'];
  const nouns = ['Panda', 'Dolphin', 'Eagle', 'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Hawk', 'Deer'];
  const randomNum = Math.floor(Math.random() * 1000);
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective}${noun}${randomNum}`;
}

// Middleware
app.use(limiter);
app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));

// Input validation
const validateRoomId = (roomId) => {
  if (!roomId || typeof roomId !== 'string') return 'Invalid room ID';
  if (roomId.length > MAX_ROOM_ID_LENGTH) return 'Room ID too long';
  if (!/^[a-zA-Z0-9-_]+$/.test(roomId)) return 'Room ID contains invalid characters';
  return null;
};

const validateText = (text) => {
  if (typeof text !== 'string') return 'Invalid text format';
  if (text.length > MAX_TEXT_LENGTH) return 'Text too long';
  return null;
};

// Routes with error handling
app.get('/', (req, res) => {
  try {
    res.sendFile(__dirname + '/public/index.html');
  } catch (error) {
    console.error('Error serving index:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/app.html', (req, res) => {
  try {
    res.sendFile(__dirname + '/public/app.html');
  } catch (error) {
    console.error('Error serving app:', error);
    res.status(500).send('Internal Server Error');
  }
});

// File upload route
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({
      success: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send immediate acknowledgment of connection
  socket.emit('connect_confirmed', { id: socket.id });

  // Generate a random user name for new connections
  const userName = generateUserName();
  userInfo.set(socket.id, { name: userName });

  socket.on('create-room', (callback) => {
    try {
      console.log('Creating new room for socket:', socket.id);
      
      // Generate a new room ID
      const roomId = generateRoomId();
      console.log('Generated room ID:', roomId);
      
      // Create new room with a Map for users
      const room = new Map();
      rooms.set(roomId, room);
      
      // Initialize empty text content and chat history
      textContent.set(roomId, '');
      chatHistory.set(roomId, []);
      
      // Get user info and add to room with proper username
      const user = userInfo.get(socket.id);
      const username = user ? user.name : 'Anonymous';
      room.set(socket.id, { name: username });
      
      // Join the room AFTER setting up the room
      socket.join(roomId);
      userRooms.set(socket.id, roomId);
      
      console.log('Room created successfully:', {
        roomId,
        socketId: socket.id,
        username,
        userCount: room.size
      });
      
      // Broadcast initial user count to the room
      io.to(roomId).emit('user-count', room.size);
      
      // Send success response with room ID
      if (typeof callback === 'function') {
        callback({
          success: true,
          roomId,
          text: '',
          messages: []
        });
      }
    } catch (error) {
      console.error('Error creating room:', error);
      if (typeof callback === 'function') {
        callback({ error: 'Failed to create room' });
      }
    }
  });

  socket.on('join-room', (roomId, callback) => {
    console.log('Attempting to join room:', roomId, 'for socket:', socket.id);
    
    if (!roomId) {
      console.log('No room ID provided');
      if (typeof callback === 'function') {
        callback({ error: 'Room ID is required' });
      }
      return;
    }

    // Validate room ID format
    const roomIdError = validateRoomId(roomId);
    if (roomIdError) {
      console.log('Invalid room ID:', roomIdError);
      if (typeof callback === 'function') {
        callback({ error: roomIdError });
      }
      return;
    }

    // Leave current room if any
    const currentRoomId = userRooms.get(socket.id);
    if (currentRoomId) {
      console.log('Leaving current room:', currentRoomId);
      const currentRoom = rooms.get(currentRoomId);
      if (currentRoom) {
        currentRoom.delete(socket.id);
        if (currentRoom.size === 0) {
          rooms.delete(currentRoomId);
          textContent.delete(currentRoomId);
          chatHistory.delete(currentRoomId);
        } else {
          io.to(currentRoomId).emit('user-count', currentRoom.size);
          const username = userInfo.get(socket.id)?.name || 'A user';
          io.to(currentRoomId).emit('user-left', { username });
        }
      }
    }

    // Check if room exists
    const room = rooms.get(roomId);
    if (!room) {
      console.log('Room not found:', roomId);
      if (typeof callback === 'function') {
        callback({ error: 'Room not found' });
      }
      return;
    }

    // Get user info and add to room with proper username
    const user = userInfo.get(socket.id);
    const username = user ? user.name : 'Anonymous';
    room.set(socket.id, { name: username });

    // Join the room AFTER setting up the user
    socket.join(roomId);
    userRooms.set(socket.id, roomId);

    console.log('Successfully joined room:', {
      roomId,
      socketId: socket.id,
      username,
      userCount: room.size
    });

    // Broadcast updated user count only to users in this room
    io.to(roomId).emit('user-count', room.size);

    // Notify other users in the room
    io.to(roomId).emit('user-joined', { username });

    // Send current text and chat history to the new user
    if (typeof callback === 'function') {
      callback({
        success: true,
        text: textContent.get(roomId) || '',
        messages: chatHistory.get(roomId) || []
      });
    }
  });

  socket.on('sync-text', (text, callback) => {
    try {
      const currentRoomId = userRooms.get(socket.id);
      if (!currentRoomId) {
        if (typeof callback === 'function') {
          callback({ error: 'Not in a room' });
        }
        return;
      }
      
      const textError = validateText(text);
      if (textError) {
        if (typeof callback === 'function') {
          callback({ error: textError });
        }
        return;
      }

      // Update text content for the room
      textContent.set(currentRoomId, text);
      
      // Broadcast to other users in the room
      socket.to(currentRoomId).emit('text-update', text);
      
      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } catch (error) {
      console.error('Error syncing text:', error);
      if (typeof callback === 'function') {
        callback({ error: 'Failed to sync text' });
      }
    }
  });

  socket.on('file-share', (data, callback) => {
    try {
      const currentRoomId = userRooms.get(socket.id);
      if (!currentRoomId) {
        return callback({ error: 'Not in a room' });
      }

      // Broadcast file info to all users in the room
      io.to(currentRoomId).emit('file-received', {
        filename: data.filename,
        originalname: data.originalname,
        size: data.size,
        mimetype: data.mimetype,
        uploadedBy: socket.id
      });

      callback({ success: true });
    } catch (error) {
      console.error('File share error:', error);
      callback({ error: 'Failed to share file' });
    }
  });

  socket.on('chat-message', (messageData, callback) => {
    const currentRoomId = userRooms.get(socket.id);
    if (!currentRoomId) {
      callback({ error: 'You must be in a room to send messages' });
      return;
    }

    const room = rooms.get(currentRoomId);
    if (!room) {
      callback({ error: 'Room not found' });
      return;
    }

    const user = userInfo.get(socket.id);
    const message = {
      text: messageData.text,
      username: user.name,
      timestamp: messageData.timestamp || Date.now()
    };

    // Get or initialize chat history for the room
    let roomChatHistory = chatHistory.get(currentRoomId) || [];
    
    // Add to chat history
    roomChatHistory.push(message);
    if (roomChatHistory.length > 50) {
      roomChatHistory.shift();
    }
    
    // Update chat history in the Map
    chatHistory.set(currentRoomId, roomChatHistory);

    // Broadcast to room
    io.to(currentRoomId).emit('chat-message', message);
    callback({ success: true });
  });

  // Handle username changes
  socket.on('set-username', (newUsername, callback) => {
    if (!newUsername || typeof newUsername !== 'string') {
      if (typeof callback === 'function') {
        callback({ error: 'Invalid username' });
      }
      return;
    }

    if (newUsername.length > 20) {
      if (typeof callback === 'function') {
        callback({ error: 'Username must be less than 20 characters' });
      }
      return;
    }

    // Update username in userInfo
    const user = userInfo.get(socket.id);
    if (user) {
      const oldUsername = user.name;
      user.name = newUsername;

      // If user is in a room, update their username in the room's user list
      const currentRoomId = userRooms.get(socket.id);
      if (currentRoomId) {
        const room = rooms.get(currentRoomId);
        if (room) {
          room.set(socket.id, { name: newUsername });
          // Broadcast updated user list to all users in the room
          const users = Array.from(room.values()).map(user => ({ name: user.name }));
          io.to(currentRoomId).emit('user-list', users);
        }
      }

      // If user is in a room, notify others about the username change
      if (currentRoomId) {
        io.to(currentRoomId).emit('username-changed', {
          oldUsername,
          newUsername,
          timestamp: Date.now()
        });
      }

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } else {
      if (typeof callback === 'function') {
        callback({ error: 'User not found' });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const currentRoomId = userRooms.get(socket.id);
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        const username = userInfo.get(socket.id)?.name || 'A user';
        room.delete(socket.id);
        
        // Broadcast user count and leave notification BEFORE potentially deleting the room
        io.to(currentRoomId).emit('user-count', room.size);
        io.to(currentRoomId).emit('user-left', {
          username,
          timestamp: Date.now()
        });
        
        if (room.size === 0) {
          rooms.delete(currentRoomId);
          textContent.delete(currentRoomId);
          chatHistory.delete(currentRoomId);
        }
      }
    }
    userInfo.delete(socket.id);
    userRooms.delete(socket.id);
  });
});

// Room cleanup interval
setInterval(() => {
  const ROOM_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TIMEOUT) {
      rooms.delete(roomId);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// Start the server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all network interfaces

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log('Access from other devices using your computer\'s IP address');
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use!`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});
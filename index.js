require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth");
const exhibitionRoutes = require("./routes/exhibitions");

const app = express();
const server = http.createServer(app);

/* ── Socket.io ── */
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

/* ── Middleware ── */
app.use(cors());
app.use(express.json());

// Serve uploaded images as static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ── Routes ── */
app.use("/api/auth", authRoutes);
app.use("/api/exhibitions", exhibitionRoutes);

/* ── Socket.io Presence Logic ── */
// Track visitors per exhibition room
const rooms = new Map(); // exhibitionId → Map<socketId, {userId, name, position, rotation}>

io.on("connection", (socket) => {
  let currentRoom = null;

  // Join an exhibition room
  socket.on("join-exhibition", ({ exhibitionId, userId, name }) => {
    currentRoom = exhibitionId;
    socket.join(exhibitionId);

    // Initialize room if needed
    if (!rooms.has(exhibitionId)) {
      rooms.set(exhibitionId, new Map());
    }

    const room = rooms.get(exhibitionId);
    room.set(socket.id, {
      userId,
      name: name || "Visitor",
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
    });

    // Send current visitors to the new joiner
    const existingVisitors = [];
    room.forEach((visitor, sid) => {
      if (sid !== socket.id) {
        existingVisitors.push({ socketId: sid, ...visitor });
      }
    });
    socket.emit("current-visitors", existingVisitors);

    // Notify others that someone joined
    socket.to(exhibitionId).emit("visitor-joined", {
      socketId: socket.id,
      userId,
      name: name || "Visitor",
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
    });

    // Send room count
    io.to(exhibitionId).emit("visitor-count", room.size);
  });

  // Position update (throttled by client at ~10hz)
  socket.on("position-update", ({ position, rotation }) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;

    const room = rooms.get(currentRoom);
    const visitor = room.get(socket.id);
    if (!visitor) return;

    visitor.position = position;
    visitor.rotation = rotation;

    // Broadcast to others in the room
    socket.to(currentRoom).emit("visitor-moved", {
      socketId: socket.id,
      position,
      rotation,
    });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.delete(socket.id);

      // Notify others
      socket.to(currentRoom).emit("visitor-left", { socketId: socket.id });
      io.to(currentRoom).emit("visitor-count", room.size);

      // Clean up empty rooms
      if (room.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

/* ── MongoDB ── */
const MONGO_URL = process.env.MONGO_URL || "YOUR_MONGODB_URL_HERE";

mongoose
  .connect(MONGO_URL)
  .then(() => {
    console.log("MongoDB connected");
    server.listen(process.env.PORT || 5000, () =>
      console.log(`Server running on port ${process.env.PORT || 5000}`),
    );
  })
  .catch((err) => console.error("MongoDB connection error:", err));

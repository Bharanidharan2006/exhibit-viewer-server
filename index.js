require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/auth");
const exhibitionRoutes = require("./routes/exhibitions");

const app = express();

/* ── Middleware ── */
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(express.json());

// Serve uploaded images as static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ── Routes ── */
app.use("/api/auth", authRoutes);
app.use("/api/exhibitions", exhibitionRoutes);

/* ── MongoDB ── */
const MONGO_URL = process.env.MONGO_URL || "YOUR_MONGODB_URL_HERE";

mongoose
  .connect(MONGO_URL)
  .then(() => {
    console.log("MongoDB connected");
    app.listen(process.env.PORT || 5000, () =>
      console.log(`Server running on port ${process.env.PORT || 5000}`),
    );
  })
  .catch((err) => console.error("MongoDB connection error:", err));

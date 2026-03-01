const jwt = require("jsonwebtoken");
const User = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret_in_production";

// Verify JWT and attach user to req
const protect = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");
    if (!req.user) return res.status(401).json({ message: "User not found" });
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

// Restrict to business owners only
const businessOnly = (req, res, next) => {
  if (req.user?.role !== "business") {
    return res.status(403).json({ message: "Business account required" });
  }
  next();
};

module.exports = { protect, businessOnly, JWT_SECRET };

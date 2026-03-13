const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Exhibition = require("../models/Exhibition");
const { protect, businessOnly } = require("../middleware/auth");

const router = express.Router();

/* ── Multer setup ── */
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  },
});

// Accept images AND 3D model files (GLB/GLTF)
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_MODEL_EXTS = [".glb", ".gltf"];

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (3D models can be large)
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith("image/") || ALLOWED_MODEL_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only image and GLB/GLTF files are allowed"));
    }
  },
});

/* ─────────────────────────────────────────────
   GET /api/exhibitions
   List all published exhibitions (customers)
   Optional: ?search=query
───────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const filter = { isPublished: true };
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: "i" };
    }
    const exhibitions = await Exhibition.find(filter)
      .populate("owner", "name")
      .select("-slots.imageUrl") // don't send image paths in list, only in detail
      .sort({ createdAt: -1 });

    // Actually we do want basic slot info for the listing cards — let's send it all
    const full = await Exhibition.find(filter)
      .populate("owner", "name")
      .sort({ createdAt: -1 });

    res.json(full);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ─────────────────────────────────────────────
   GET /api/exhibitions/mine
   Business owner's own exhibitions
───────────────────────────────────────────── */
router.get("/mine", protect, businessOnly, async (req, res) => {
  try {
    const exhibitions = await Exhibition.find({ owner: req.user._id }).sort({
      createdAt: -1,
    });
    res.json(exhibitions);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

/* ─────────────────────────────────────────────
   GET /api/exhibitions/:id
   Single exhibition full detail (for 3D viewer)
───────────────────────────────────────────── */
router.get("/:id", async (req, res) => {
  try {
    const exhibition = await Exhibition.findById(req.params.id).populate(
      "owner",
      "name email",
    );
    if (!exhibition)
      return res.status(404).json({ message: "Exhibition not found" });
    res.json(exhibition);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

/* ─────────────────────────────────────────────
   GET /api/exhibitions/:id/slots/:slotName
   Public endpoint — returns a single slot's data
   for the AR product preview (no auth required)
───────────────────────────────────────────── */
router.get("/:id/slots/:slotName", async (req, res) => {
  try {
    const exhibition = await Exhibition.findById(req.params.id)
      .populate("owner", "name");
    if (!exhibition)
      return res.status(404).json({ message: "Exhibition not found" });

    const slot = exhibition.slots.find(
      (s) => s.slotName === req.params.slotName,
    );
    if (!slot)
      return res.status(404).json({ message: "Slot not found" });

    res.json({
      slotName: slot.slotName,
      slotType: slot.slotType,
      modelUrl: slot.modelUrl,
      imageUrl: slot.imageUrl,
      title: slot.title,
      artist: slot.artist,
      description: slot.description,
      price: slot.price,
      medium: slot.medium,
      dimensions: slot.dimensions,
      year: slot.year,
      likes: slot.likes,
      exhibitionName: exhibition.name,
      ownerName: exhibition.owner?.name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ─────────────────────────────────────────────
   POST /api/exhibitions
   Create a new exhibition (business only)
───────────────────────────────────────────── */
router.post("/", protect, businessOnly, async (req, res) => {
  try {
    const { name, description, modelTemplate, slotCount, productSlotCount } = req.body;

    if (!name || !modelTemplate || !slotCount) {
      return res
        .status(400)
        .json({ message: "name, modelTemplate and slotCount are required" });
    }

    // Pre-create empty slots: SLOT_n for images, SLOT_P_n for 3D products
    const slots = [];
    for (let i = 1; i <= Number(slotCount); i++) {
      slots.push({ slotName: `SLOT_${i}`, slotType: "image" });
    }
    for (let i = 1; i <= Number(productSlotCount || 0); i++) {
      slots.push({ slotName: `SLOT_P_${i}`, slotType: "model3d" });
    }

    const exhibition = await Exhibition.create({
      owner: req.user._id,
      name,
      description,
      modelTemplate,
      slots,
    });

    res.status(201).json(exhibition);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ─────────────────────────────────────────────
   POST /api/exhibitions/:id/slots/:slotName/upload
   Upload an image + metadata for a specific slot
   (multipart/form-data)
───────────────────────────────────────────── */
router.post(
  "/:id/slots/:slotName/upload",
  protect,
  businessOnly,
  upload.fields([{ name: "image", maxCount: 1 }, { name: "model", maxCount: 1 }]),
  async (req, res) => {
    try {
      const exhibition = await Exhibition.findOne({
        _id: req.params.id,
        owner: req.user._id,
      });
      if (!exhibition)
        return res.status(404).json({ message: "Exhibition not found" });

      const slot = exhibition.slots.find(
        (s) => s.slotName === req.params.slotName,
      );
      if (!slot) return res.status(404).json({ message: "Slot not found" });

      // Handle image upload
      const imageFile = req.files?.image?.[0];
      if (imageFile) {
        if (slot.imageUrl) {
          const oldPath = path.join(uploadDir, path.basename(slot.imageUrl));
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        slot.imageUrl = `/uploads/${imageFile.filename}`;
      }

      // Handle 3D model upload
      const modelFile = req.files?.model?.[0];
      if (modelFile) {
        if (slot.modelUrl) {
          const oldPath = path.join(uploadDir, path.basename(slot.modelUrl));
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        slot.modelUrl = `/uploads/${modelFile.filename}`;
        slot.slotType = "model3d";
      }

      // Auto-detect slot type from slot name convention
      if (slot.slotName.startsWith("SLOT_P_")) {
        slot.slotType = "model3d";
      }

      // Update metadata fields
      const { title, artist, description, price, medium, dimensions, year, slotType } =
        req.body;
      if (slotType !== undefined) slot.slotType = slotType;
      if (title !== undefined) slot.title = title;
      if (artist !== undefined) slot.artist = artist;
      if (description !== undefined) slot.description = description;
      if (price !== undefined) slot.price = Number(price);
      if (medium !== undefined) slot.medium = medium;
      if (dimensions !== undefined) slot.dimensions = dimensions;
      if (year !== undefined) slot.year = Number(year);

      await exhibition.save();
      res.json({ slot, imageUrl: slot.imageUrl, modelUrl: slot.modelUrl });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

/* ─────────────────────────────────────────────
   PATCH /api/exhibitions/:id/publish
   Publish / unpublish exhibition (business only)
───────────────────────────────────────────── */
router.patch("/:id/publish", protect, businessOnly, async (req, res) => {
  try {
    const exhibition = await Exhibition.findOne({
      _id: req.params.id,
      owner: req.user._id,
    });
    if (!exhibition)
      return res.status(404).json({ message: "Exhibition not found" });

    exhibition.isPublished = !exhibition.isPublished;
    await exhibition.save();
    res.json({ isPublished: exhibition.isPublished });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

/* ─────────────────────────────────────────────
   POST /api/exhibitions/:id/slots/:slotName/like
   Increment like count (any authenticated user)
───────────────────────────────────────────── */
router.post("/:id/slots/:slotName/like", protect, async (req, res) => {
  try {
    const exhibition = await Exhibition.findById(req.params.id);
    if (!exhibition)
      return res.status(404).json({ message: "Exhibition not found" });

    const slot = exhibition.slots.find(
      (s) => s.slotName === req.params.slotName,
    );
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    slot.likes += 1;
    await exhibition.save();

    res.json({ likes: slot.likes });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;

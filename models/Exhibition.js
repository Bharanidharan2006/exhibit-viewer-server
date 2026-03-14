const mongoose = require("mongoose");

const slotSchema = new mongoose.Schema({
  slotName: { type: String, required: true }, // e.g. "SLOT_1" or "SLOT_P_1"
  slotType: { type: String, enum: ["image", "model3d"], default: "image" },
  imageUrl: { type: String, default: null }, // path served from /uploads/
  modelUrl: { type: String, default: null }, // GLB/GLTF file path for 3D products
  title: { type: String, default: "" },
  artist: { type: String, default: "" },
  description: { type: String, default: "" },
  price: { type: Number, default: 0 },
  medium: { type: String, default: "" },
  dimensions: { type: String, default: "" },
  year: { type: Number, default: new Date().getFullYear() },
  likes: { type: Number, default: 0 },
});

const exhibitionSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    modelTemplate: { type: String, required: true }, // matches a key in GALLERY_TEMPLATES on client
    slots: [slotSchema],
    isPublished: { type: Boolean, default: false },
    aiShopkeeper: {
      enabled: { type: Boolean, default: false },
      exhibitionStory: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Exhibition", exhibitionSchema);

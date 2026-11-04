var mongoose = require("mongoose");
var teacherSchema   =   new mongoose.Schema({
    name:String,
    classname:String,
    ownerTokenHash: { type: String, select: false },
    currentSlide: { type: Number, default: 1 },
    status: { type: String, enum: ['queued', 'processing', 'ready', 'failed'], default: 'ready' },
    sourceType: { type: String, enum: ['images', 'pptx', 'pdf'], default: 'images' },
    conversionError: { type: String, default: '' },
    convertedSlides: { type: Number, default: 0 },
    totalSlides: { type: Number, default: 0 },
    pptimages:[{
        type:String
    }]
});

module.exports  =   mongoose.model("teacher",teacherSchema);

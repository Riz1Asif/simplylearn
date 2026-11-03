var mongoose = require("mongoose");
var teacherSchema   =   new mongoose.Schema({
    name:String,
    classname:String,
    ownerTokenHash: { type: String, select: false },
    currentSlide: { type: Number, default: 1 },
    pptimages:[{
        type:String
    }]
});

module.exports  =   mongoose.model("teacher",teacherSchema);

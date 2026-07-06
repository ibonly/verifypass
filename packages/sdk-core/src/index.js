"use strict";

const client = require("./client");
const flow = require("./flow");
const quality = require("./quality");
const camera = require("./camera");
const device = require("./device");
const faceDetectMath = require("./faceDetectMath");

exports.VerifyPassClient = client.VerifyPassClient;
exports.VerifyPassApiError = client.VerifyPassApiError;
exports.parseSdkToken = client.parseSdkToken;
exports.createFlow = flow.createFlow;
exports.STEP_SEQUENCES = flow.STEP_SEQUENCES;
exports.TERMINAL_STATUSES = flow.TERMINAL_STATUSES;
exports.toGrayscale = quality.toGrayscale;
exports.laplacianVariance = quality.laplacianVariance;
exports.meanBrightness = quality.meanBrightness;
exports.frameMotion = quality.frameMotion;
exports.assessFrame = quality.assessFrame;
exports.DEFAULT_RULES = quality.DEFAULT_RULES;
exports.startCamera = camera.startCamera;
exports.stopCamera = camera.stopCamera;
exports.captureFrame = camera.captureFrame;
exports.grabAnalysisFrame = camera.grabAnalysisFrame;
exports.grabFixedFrame = camera.grabFixedFrame;
exports.grabSquareFrame = camera.grabSquareFrame;
exports.collectDeviceSignals = device.collectDeviceSignals;

const actionSignals = require("./actionSignals");
exports.actionGeometry = actionSignals.actionGeometry;
exports.bandMotion = actionSignals.bandMotion;
exports.createActionDetector = actionSignals.createActionDetector;
exports.ACTION_GEO = actionSignals.ACTION_GEO;

const documentGate = require("./documentGate");
exports.createDocumentGate = documentGate.createDocumentGate;
exports.assessDocumentShape = documentGate.assessDocumentShape;
exports.isDominantFace = documentGate.isDominantFace;
exports.DOCUMENT_GATE_DEFAULTS = documentGate.DOCUMENT_GATE_DEFAULTS;
exports.DOCUMENT_SHAPE_DEFAULTS = documentGate.DOCUMENT_SHAPE_DEFAULTS;

const stabilizer = require("./stabilizer");
exports.createFramingStabilizer = stabilizer.createFramingStabilizer;
exports.detectActionTrigger = stabilizer.detectActionTrigger;
exports.STABILIZER_DEFAULTS = stabilizer.STABILIZER_DEFAULTS;
exports.ACTION_TRIGGER = stabilizer.ACTION_TRIGGER;
exports.DETECT_CONFIG = faceDetectMath.DETECT_CONFIG;
exports.bestFaceBox = faceDetectMath.bestFaceBox;
exports.assessFraming = faceDetectMath.assessFraming;

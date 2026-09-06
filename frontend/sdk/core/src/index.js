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
exports.needsDocumentBack = flow.needsDocumentBack;
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
exports.captureGuideFrame = camera.captureGuideFrame;
exports.grabAnalysisFrame = camera.grabAnalysisFrame;
exports.grabFixedFrame = camera.grabFixedFrame;
exports.grabSquareFrame = camera.grabSquareFrame;
exports.collectDeviceSignals = device.collectDeviceSignals;
exports.collectCaptureSignals = require("./captureIntegrity").collectCaptureSignals;
const landmarks = require("./landmarks");
exports.poseFromLandmarks = landmarks.poseFromLandmarks;
exports.landmarkInputFromImageData = landmarks.landmarkInputFromImageData;
exports.poseActionVerdict = landmarks.poseActionVerdict;
exports.isFrontalPose = landmarks.isFrontalPose;
exports.isReferencePose = landmarks.isReferencePose;
exports.frontalRefFromSamples = landmarks.frontalRefFromSamples;
exports.createPoseSmoother = landmarks.createPoseSmoother;
exports.POSE_THRESHOLDS = landmarks.POSE_THRESHOLDS;
exports.LANDMARK_INPUT = landmarks.LANDMARK_INPUT;
exports.exprFromLandmarks = landmarks.exprFromLandmarks;
exports.eyeAspectRatio = landmarks.eyeAspectRatio;
exports.mouthAspectRatio = landmarks.mouthAspectRatio;
exports.EXPRESSION = landmarks.EXPRESSION;

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

const flash = require("./flash");
exports.FLASH = flash.FLASH;
exports.randomFlashSequence = flash.randomFlashSequence;
exports.flashCropRect = flash.flashCropRect;
exports.meanRgb = flash.meanRgb;

const modelCache = require("./modelCache");
exports.fetchWithCache = modelCache.fetchWithCache;
exports.clearModelCache = modelCache.clearModelCache;
exports.DEFAULT_CACHE_NAME = modelCache.DEFAULT_CACHE_NAME;

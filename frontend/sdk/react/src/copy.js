// Every user-facing string in the widget. Integrators override any subset via
// the `copy` prop (deep-merged one level per section); entries that take
// arguments may be overridden with a string or a function.

export const DEFAULT_CONSENT_COPY = "I consent to VerifyPass capturing and processing my ID images, my selfie, short video frames of my head movements, and my device and camera details (such as camera type and browser) to verify my identity and prevent fraud. This includes biometric processing. The check may briefly change my screen colour a few times; this is skipped automatically if my device asks for reduced motion. Images are stored securely for the period set by the organisation that requested this verification, then deleted.";
// Bump when the consent wording changes — recorded server-side with each
// consent so audits know WHICH text the user accepted.
export const CONSENT_COPY_VERSION = "2026-10-09.1"; // screen-flash disclosure folded into the single consent statement (separate opt-in removed)

export const DEFAULT_COPY = {
  steps: {
    document: { title: "Scan your ID", hint: "Place your ID inside the frame. Avoid glare and shadows." },
    document_back: { title: "Scan the BACK of your ID", hint: "Flip your ID over and place the back inside the frame." },
    liveness: { title: "Liveness check", hint: "Follow the prompt so we know you're really here." },
    face: { title: "Take a selfie", hint: "Look straight at the camera in good lighting." },
    processing: { title: "Verifying…", hint: "This usually takes a few seconds." },
    complete: { title: "Done", hint: "" },
    mobile: { title: "Verify on your phone", hint: "Scan the QR code with your phone camera to continue." }
  },
  // Prompts for each server-issued challenge action.
  actions: {
    // a real blink is ~150 ms — too quick for the capture pipeline, so ask for
    // a slow one: the closed-eye frame is captured while the eyes are shut
    blink: "Close your eyes for a second, then open them",
    open_mouth: "Open your mouth wide and hold it for a moment",
    turn_left: "Slowly turn your head toward the arrow on the LEFT side of the screen",
    turn_right: "Slowly turn your head toward the arrow on the RIGHT side of the screen",
    look_up: "Tilt your head UP — lift your chin toward the ceiling",
    look_down: "Tilt your head DOWN",
    smile: "Smile"
  },
  // Short on-screen pill text (the arrow carries the side).
  pills: {
    turn_left: "Turn toward the ← arrow",
    turn_right: "Turn toward the → arrow",
    look_up: "Lift your chin — look UP",
    look_down: "Lower your chin — look DOWN",
    blink: "Close your eyes, then open them",
    open_mouth: "Open your mouth wide"
  },
  // Arrow aria-labels: SCREEN-relative on purpose ("your left" is ambiguous on
  // cameras that pre-mirror their frames).
  arrows: {
    turn_left: "Turn your head toward the arrow on the left side of the screen",
    turn_right: "Turn your head toward the arrow on the right side of the screen",
    look_up: "Tilt your head up, lifting your chin toward the ceiling",
    look_down: "Tilt your head down, lowering your chin toward your chest"
  },
  // Diagnosis-driven coaching; each entry receives the current action.
  coach: {
    wrong_way: (a) => a === "look_up" ? "That's down — lift your chin and look UP"
      : a === "look_down" ? "That's up — lower your chin and look DOWN"
      : "Other way — turn your head toward the arrow",
    face_lost: () => "We lost your face — come back a little so we can still see you",
    recenter: () => "Face the camera straight first — then do the movement",
    budget: () => "We've recorded everything we can for this movement. Continue — if it isn't accepted you'll be asked to try again.",
    further: (a) => a === "look_up" ? "Almost — lift your chin further, toward the ceiling"
      : a === "look_down" ? "Almost — lower your chin a bit more"
      : a === "blink" ? "Almost — close your eyes fully for a second, then open them"
      : a === "open_mouth" ? "Almost — open your mouth wider and hold it"
      : "Almost — keep turning toward the arrow and hold it",
    none: (a) => a === "look_up" || a === "look_down" ? "We haven't seen it yet — tilt your head slowly and hold"
      : a === "blink" ? "We haven't seen it yet — close your eyes for a full second, then open them"
      : a === "open_mouth" ? "We haven't seen it yet — open your mouth wide and hold it"
      : "We haven't seen it yet — turn slowly toward the arrow and hold"
  },
  // Framing guidance from the client face model.
  guide: {
    model_loading: "Loading face model...",
    model_error: "Face model unavailable - capture manually",
    no_face: "Position your face in the circle",
    move_closer: "Move closer",
    move_back: "Move back",
    center: "Center your face",
    focus: "Hold steady - image is soft"
  },
  issues: {
    DOCUMENT_BLURRY: "Image looks blurry — hold steady and try again.",
    TOO_DARK: "Too dark — move somewhere brighter.",
    TOO_BRIGHT: "Too bright — reduce direct light or glare."
  },
  // Labels for user-actionable rejection reason codes on the result screen.
  reasons: {
    LIVENESS_FAILED: "Liveness check failed",
    LIVENESS_BORDERLINE: "Liveness score was borderline",
    LIVENESS_CHALLENGE_FAILED: "Liveness challenge actions not detected",
    LIVENESS_CHALLENGE_INCOMPLETE: "Liveness challenge was not completed",
    LIVENESS_CHALLENGE_EXPIRED: "The liveness challenge timed out — try again",
    LIVENESS_CHALLENGE_SEQUENCE_INVALID: "The movements took too long or were out of order — try again without pausing",
    LIVENESS_POSE_UNAVAILABLE: "We couldn't measure your head movements — try again with your face well lit and fully in the circle",
    DOCUMENT_IMAGE_LOW_QUALITY: "Your ID photo was blurry or poorly lit",
    DOCUMENT_IS_LIVE_FACE: "We saw a face instead of your ID card",
    SESSION_TIMEOUT: "The verification took too long — please try again",
    FACE_MATCH_FAILED: "Face doesn't match the ID document",
    FACE_MATCH_BORDERLINE: "Face similarity score was borderline",
    NO_FACE_ON_SELFIE: "No face detected in your selfie",
    NO_FACE_ON_DOCUMENT: "No face detected on your ID document",
    MULTIPLE_FACES_DETECTED: "Multiple faces detected in the image",
    DOCUMENT_OCR_FAILED: "Could not read the text on your ID",
    DOCUMENT_EXPIRED: "Your ID document appears to be expired",
    DEVICE_SHARED_ACROSS_IDENTITIES: "This device has been flagged for suspicious activity",
    TOO_MANY_FAILED_ATTEMPTS: "Too many failed attempts — please try again later",
    IP_RATE_LIMIT: "Too many requests from your network"
  },
  consent: {
    title: "Consent required",
    statement: DEFAULT_CONSENT_COPY,
    continue: "Continue",
    or: "or",
    showQr: "Show QR code",
    qrHint: "Scan it with your phone and finish there. You'll give consent on your phone."
  },
  capture: {
    livenessTitle: (index, total) => `Liveness check (${index}/${total})`,
    pillDocument: "Fit your ID inside the frame",
    pillFace: "Center your face in the circle",
    positionFace: "Position your face",
    startingCamera: "Starting camera…",
    gotIt: "Got it — hold on…",
    doItNow: "Do it now — we'll capture automatically",
    uploading: "Uploading…",
    loadingDetection: "Loading face detection…",
    noAutoDetection: "Automatic detection isn't available here — do the movement, then tap Capture manually",
    getReady: "Get ready…",
    centerToBegin: "Center your face to begin",
    holdStill: "Hold still…",
    alignFace: "Align your face in the circle",
    documentIsFace: "That's a face — hold up your ID card instead",
    documentFit: "Fit your ID inside the box",
    documentHold: "Hold steady…",
    retry: "Retry",
    flashHold: "Hold still — checking lighting",
    cameraPaused: "Camera paused — tap to resume",
    cameraDenied: "Camera permission was denied. Please allow camera access in your device/browser settings, then click Retry.",
    cameraFailed: "Failed to access camera.",
    reissue: "I can't do this movement — try a different one",
    continueNext: "Continue to the next movement",
    captureManually: "Capture manually",
    uploadDocument: "Upload a photo of your ID instead"
  },
  processing: { message: "Checking liveness and matching your ID…" },
  mobile: {
    intro: "Open your phone's camera app and point it at this QR code. It opens the verification page in your phone's browser.",
    qrAlt: "QR code — scan with your phone camera",
    generating: "Generating QR…",
    retryQr: "Retry QR code",
    copyLink: "Copy secure link",
    openHere: "Open on this device",
    linkCopied: "Secure link copied. Treat it like a password.",
    copyFailed: "Could not copy the link. Open it in a new tab instead.",
    qrEncodeFailed: "Unable to generate the QR code. Retry or copy the secure link.",
    qrLoadFailed: "Unable to load the QR generator. Retry or copy the secure link.",
    privacy: "This code and link are private, expire shortly, and can be claimed once. Do not share or screenshot them.",
    codeExpires: (time) => ` Code expires ${time}.`,
    sessionExpires: (time) => ` Session expires ${time}.`,
    verifying: "Verifying on your phone — this usually takes a few seconds",
    finalising: "Finalising your verification on your phone…",
    waiting: "Scan the code above to begin",
    useThisDevice: "Use this device instead"
  },
  outcome: {
    approved: "Verification approved.",
    manual_review: "Your verification is under review. You can wait to be notified — or try again now.",
    unsuccessful: "Verification was not successful.",
    improve: "What to improve if you try again:",
    reasons: "Reasons:",
    tryAgain: "Try again",
    restarting: "Restarting…",
    attempt: (attempts, max) => `Attempt ${attempts} of ${max}`,
    manualUploadNext: " — you can also upload a photo of your ID on the next try",
    exhausted: "All attempts have been used. Please contact support to continue."
  },
  loading: "Loading verification…",
  retryLoading: "Retry loading verification"
};

/** Merge integrator overrides over the defaults (one level per section). */
export function mergeCopy(overrides, consentCopy) {
  const out = { ...DEFAULT_COPY };
  if (overrides && typeof overrides === "object") {
    for (const [key, value] of Object.entries(overrides)) {
      const base = DEFAULT_COPY[key];
      if (base && typeof base === "object" && value && typeof value === "object") {
        out[key] = { ...base };
        for (const [k, v] of Object.entries(value)) {
          out[key][k] = base[k] && typeof base[k] === "object" && v && typeof v === "object" ? { ...base[k], ...v } : v;
        }
      } else if (value !== undefined) {
        out[key] = value;
      }
    }
  }
  if (typeof consentCopy === "string" && consentCopy) out.consent = { ...out.consent, statement: consentCopy };
  return out;
}

/** Copy entries may be strings or functions of their arguments. */
export function fmt(entry, ...args) {
  return typeof entry === "function" ? entry(...args) : entry;
}

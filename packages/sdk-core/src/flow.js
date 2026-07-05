"use strict";

// Verification flow state machine. UI layers (React widget, vanilla bundle,
// hosted page) render off this; they never invent their own step order.

const STEP_SEQUENCES = {
  ID_AND_FACE: ["document", "liveness", "face", "processing", "complete"],
  ID_ONLY: ["document", "processing", "complete"],
  FACE_ONLY: ["liveness", "face", "processing", "complete"]
};

const TERMINAL_STATUSES = ["approved", "rejected", "manual_review", "expired", "failed", "abandoned"];

function createFlow(verificationType = "ID_AND_FACE") {
  const steps = STEP_SEQUENCES[verificationType];
  if (!steps) throw new Error(`Unknown verificationType: ${verificationType}`);

  let index = 0;
  let error = null;
  let result = null;
  const listeners = new Set();

  function emit() {
    const snapshot = state();
    listeners.forEach((fn) => fn(snapshot));
  }

  function state() {
    return {
      step: steps[index],
      stepIndex: index,
      steps: [...steps],
      error,
      result,
      done: steps[index] === "complete"
    };
  }

  return {
    state,
    steps: [...steps],

    /** Advance after a step's work succeeds. */
    advance() {
      if (index < steps.length - 1) {
        index++;
        error = null;
        emit();
      }
      return state();
    },

    /** Record a recoverable error; UI shows message + retry on same step. */
    fail(err) {
      error = { code: err.code || "INTERNAL_ERROR", message: err.message || String(err) };
      emit();
      return state();
    },

    retry() {
      error = null;
      emit();
      return state();
    },

    /** Terminal result from the API ends the flow. */
    finish(apiResult) {
      result = apiResult;
      index = steps.length - 1;
      error = null;
      emit();
      return state();
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

module.exports = { createFlow, STEP_SEQUENCES, TERMINAL_STATUSES };

"use strict";

class ProtocolError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = { ProtocolError };

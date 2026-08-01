// Errors carrying an HTTP status and a stable machine-readable code. `expose`
// marks a message as safe to send to the client verbatim; anything without it
// is reported as a generic 500 by the error middleware.
function httpError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  if (extra) Object.assign(err, extra);
  return err;
}

module.exports = { httpError };

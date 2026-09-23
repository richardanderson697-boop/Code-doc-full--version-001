// Express 4 does not forward rejections from async handlers to the error
// middleware: the rejection is unhandled, and Node 22 terminates the process
// by default. One malformed request could therefore take the server down.
//
// Wrap every async handler with this so a rejection reaches the standard
// error middleware and becomes a 500 instead of an exit.
import type { Request, Response, NextFunction, RequestHandler } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncRoute(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

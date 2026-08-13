import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { messages as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import type { MessagesService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface MessagesRouterDeps {
  service: MessagesService;
  requireAuth: RequestHandler;
}

/** The `messages` HTTP surface (company + direct + group). Mounted broadly under `/api`. */
export function createMessagesRouter(deps: MessagesRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  router.use(helmet());
  router.use(pinoHttp());
  router.use(express.json());
  router.use(requireAuth);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        next(err);
      });

  const parseBody = (req: Request, res: Response) => {
    const parsed = contracts.messageSend.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return null;
    }
    return parsed.data.body;
  };

  // Company conversation.
  router.get("/companies/:companyId/messages", handle(async (req, res) => {
    res.json(await service.companyList(req.user!, req.params.companyId!));
  }));
  router.post("/companies/:companyId/messages", handle(async (req, res) => {
    const body = parseBody(req, res);
    if (body === null) return;
    res.status(201).json(await service.companySend(req.user!, req.params.companyId!, body));
  }));

  // Direct conversation.
  router.get("/companies/:companyId/direct-messages/:recipientId", handle(async (req, res) => {
    res.json(await service.directList(req.user!, req.params.companyId!, req.params.recipientId!));
  }));
  router.post("/companies/:companyId/direct-messages/:recipientId", handle(async (req, res) => {
    const body = parseBody(req, res);
    if (body === null) return;
    res.status(201).json(await service.directSend(req.user!, req.params.companyId!, req.params.recipientId!, body));
  }));

  // Groups.
  router.get("/my-groups", handle(async (req, res) => {
    res.json(await service.groupsForUser(req.user!));
  }));
  router.get("/companies/:companyId/message-groups", handle(async (req, res) => {
    res.json(await service.groupsByCompany(req.user!, req.params.companyId!));
  }));
  router.post("/companies/:companyId/message-groups", handle(async (req, res) => {
    const parsed = contracts.groupCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.createGroup(req.user!, req.params.companyId!, parsed.data));
  }));
  router.get("/message-groups/:groupId/members", handle(async (req, res) => {
    res.json(await service.listMembers(req.user!, req.params.groupId!));
  }));
  router.post("/message-groups/:groupId/members", handle(async (req, res) => {
    const parsed = contracts.groupMemberAdd.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.addMember(req.user!, req.params.groupId!, parsed.data.user_id));
  }));
  router.delete("/message-groups/:groupId/members/:userId", handle(async (req, res) => {
    await service.removeMember(req.user!, req.params.groupId!, req.params.userId!);
    res.status(204).send();
  }));

  // Group messages + reads.
  router.get("/message-groups/:groupId/messages", handle(async (req, res) => {
    res.json(await service.groupMessages(req.user!, req.params.groupId!));
  }));
  router.post("/message-groups/:groupId/messages", handle(async (req, res) => {
    const body = parseBody(req, res);
    if (body === null) return;
    res.status(201).json(await service.sendGroupMessage(req.user!, req.params.groupId!, body));
  }));
  router.post("/message-groups/:groupId/messages/mark-read", handle(async (req, res) => {
    await service.markRead(req.user!, req.params.groupId!);
    res.status(204).send();
  }));
  router.get("/message-groups/:groupId/messages/unread-count", handle(async (req, res) => {
    res.json(await service.unreadCount(req.user!, req.params.groupId!));
  }));

  return router;
}

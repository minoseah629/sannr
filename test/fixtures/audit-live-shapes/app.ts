import { createParentIdentityRouter, createChildIdentityRouter, createPublicIdentityRouter } from "./identity/identity.routes.js";
import express from "express";
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(
  "/api/v0/parent",
  createParentIdentityRouter({ parentIdentityProvider, service: identityService, photoService }),
);
app.use(
  "/api/v0",
  createPublicIdentityRouter(identityService, rateLimiterA, rateLimiterB),
);
app.use(
  "/api/v0/child",
  createChildIdentityRouter(identityService, eventAppender, achievementEngine, deliveryGate,
    photoService, plannerParseService, homeworkCheckService, tutorService,),
);
app.use(someErrorHandler);

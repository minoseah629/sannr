import { createChildIdentityRouter } from "./identity.routes.ts";
const app = express();
app.use("/api/v0/child", createChildIdentityRouter(deps));

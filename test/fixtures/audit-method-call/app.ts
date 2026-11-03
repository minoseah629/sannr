const app = express();
app.use("/api/v0/local-photo-objects", photoObjectStore.router());

class PhotoObjectStore {
  router() {
    const r = Router();
    r.get("/", handler);
    r.put("/", handler);
    r.delete("/undocumented", handler);
    return r;
  }
}
const photoObjectStore = new PhotoObjectStore();

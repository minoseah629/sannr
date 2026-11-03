import express from "express";
const photoObjectStore = options.photoObjectStore ?? createPhotoObjectStore(env);
const app = express();
if (isFileSystemPhotoObjectStore(photoObjectStore)) {
  app.use("/api/v0/local-photo-objects", photoObjectStore.router());
}

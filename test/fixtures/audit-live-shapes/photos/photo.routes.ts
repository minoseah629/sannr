export function registerChildPhotoRoutes(router: Router, service: PhotoService): void {
  router.post("/photos/authorize", handler);
}
export function registerParentPhotoRoutes(router: Router, service: PhotoService): void {
  router.post("/photos/authorize", handler);
}
export function registerChildPlannerRoutes(router: Router, service: PlannerParseService): void {
  router.post("/planner/parse", handler);
}
export function registerChildHomeworkRoutes(router: Router, service: HomeworkCheckService): void {
  router.post("/homework/check", handler);
}
export function registerChildTutorRoutes(router: Router, service: TutorService): void {
  router.post("/tutor/ask", handler);
}

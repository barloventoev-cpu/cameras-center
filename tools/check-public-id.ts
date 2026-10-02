import { publicIdFromUrl } from "../apps/server/src/retention";

const cases: Array<[string, string, string | null]> = [
  ["https://res.cloudinary.com/drqami3r/video/upload/v1790974768/cameras-center/clips/3b31713b-4e3f-4a37-a51a-cad59b9ab615-1790974753488.mp4", "drqami3r", "video:cameras-center/clips/3b31713b-4e3f-4a37-a51a-cad59b9ab615-1790974753488"],
  ["https://res.cloudinary.com/drqami3r/image/upload/v1790974700/cameras-center/events/3b31713b/1790974700123-ab12cd34.jpg", "drqami3r", "image:cameras-center/events/3b31713b/1790974700123-ab12cd34"],
  ["https://res.cloudinary.com/drqami3r/image/upload/cameras-center/abc.jpg", "drqami3r", "image:cameras-center/abc"],
  ["https://res.cloudinary.com/otranube/image/upload/v1/x.jpg", "drqami3r", null],
  ["https://example.com/foto.jpg", "drqami3r", null],
  ["no-es-url", "drqami3r", null],
];
let fails = 0;
for (const [url, cloud, want] of cases) {
  const got = publicIdFromUrl(url, cloud);
  const gotStr = got ? `${got.resourceType}:${got.publicId}` : null;
  const ok = gotStr === want;
  if (!ok) fails++;
  console.log(`${ok ? "OK  " : "FALLA"} ${url.slice(0, 60)} -> ${gotStr}`);
}
console.log(fails === 0 ? "PARSER OK" : `${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

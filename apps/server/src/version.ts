import pkg from "../package.json" with { type: "json" };

/** Release version; CI injects `APP_VERSION` into the Docker image. */
export const APP_VERSION: string = process.env.APP_VERSION ?? pkg.version;

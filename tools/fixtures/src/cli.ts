import { generateFixtures } from "./generate";

await generateFixtures({ force: process.argv.includes("--force"), log: console.log });

import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { createIngressHandler } from "./handler";

export class RelayContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "2h"; // spike: observe sleep behavior vs active WS (CF containers bug #162 watch)
  envVars = {
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    BUZZ_S3_ENDPOINT: env.BUZZ_S3_ENDPOINT,
    BUZZ_S3_ACCESS_KEY: env.BUZZ_S3_ACCESS_KEY,
    BUZZ_S3_SECRET_KEY: env.BUZZ_S3_SECRET_KEY,
    BUZZ_S3_BUCKET: env.BUZZ_S3_BUCKET,
    BUZZ_S3_REGION: env.BUZZ_S3_REGION,
    RELAY_OPERATOR_PUBKEYS: env.RELAY_OPERATOR_PUBKEYS,
    RELAY_OPERATOR_API_ORIGIN: env.RELAY_OPERATOR_API_ORIGIN,
    RELAY_URL: env.RELAY_URL,
    BUZZ_MEDIA_BASE_URL: env.BUZZ_MEDIA_BASE_URL,
    BUZZ_BIND_ADDR: env.BUZZ_BIND_ADDR,
    BUZZ_HUDDLE_AUDIO_AVAILABLE: env.BUZZ_HUDDLE_AUDIO_AVAILABLE,
  };
}

export class IdentityBridgeContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "2h";
  envVars = {
    TEAMS_PRODUCT_API_URL: env.TEAMS_PRODUCT_API_URL,
    TEAMS_IDENTITY_BRIDGE_SECRET: env.TEAMS_IDENTITY_BRIDGE_SECRET,
    TEAMS_PROVISIONING_CONTROL_SECRET: env.TEAMS_PROVISIONING_CONTROL_SECRET,
    TEAMS_BUNKER_SECRET_KEY: env.TEAMS_BUNKER_SECRET_KEY,
    TEAMS_OPERATOR_SECRET_KEY: env.TEAMS_OPERATOR_SECRET_KEY,
    TEAMS_OPERATOR_API_ORIGIN: env.RELAY_OPERATOR_API_ORIGIN,
    TEAMS_OPERATOR_SERVICE_SECRET: env.TEAMS_OPERATOR_SERVICE_SECRET,
    TEAMS_RELAY_SERVICE_SECRET: env.TEAMS_RELAY_SERVICE_SECRET,
    TEAMS_BUNKER_BIND_ADDR: "0.0.0.0:3000",
  };
}

export default {
  fetch: createIngressHandler(),
};

// Dev content: a couple of banners and news posts in every language, added
// only when those tables are empty. Edit them with `pnpm --filter lobby db:studio`.
import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { banner, newsPost } from "../src/db/schema.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const BANNERS = {
  en: [
    {
      title: "The Grand Prix is open",
      subtitle: "Summer on the bay, winter on the mountain. One championship.",
      action: "play",
      theme: "season:summer",
    },
    {
      title: "Winter has come to Costa Nevada",
      subtitle: "2.2 km from the summit hut down to the village.",
      action: "news:mountain-run",
      theme: "season:winter",
    },
  ],
  es: [
    {
      title: "El Gran Premio está abierto",
      subtitle: "Verano en la bahía, invierno en la montaña. Un solo campeonato.",
      action: "play",
      theme: "season:summer",
    },
    {
      title: "El invierno llega a Costa Nevada",
      subtitle: "2,2 km desde el refugio de la cima hasta el pueblo.",
      action: "news:mountain-run",
      theme: "season:winter",
    },
  ],
  ca: [
    {
      title: "El Gran Premi és obert",
      subtitle: "Estiu a la badia, hivern a la muntanya. Un sol campionat.",
      action: "play",
      theme: "season:summer",
    },
    {
      title: "L'hivern arriba a Costa Nevada",
      subtitle: "2,2 km des del refugi del cim fins al poble.",
      action: "news:mountain-run",
      theme: "season:winter",
    },
  ],
};

const NEWS = {
  en: [
    {
      slug: "welcome",
      title: "Welcome to Costa Nevada",
      body: "A coast where the beach and the ski slopes are close together. Every season brings a different sport: jetski in summer, snowboard in winter, and more to come.\n\nRace your friends in a private room, or jump into matchmaking.",
      daysAgo: 2,
    },
    {
      slug: "mountain-run",
      title: "The mountain run is open",
      body: "From the summit hut to the village: open slopes, rollers and tables, tree-lined S-turns, a cliff drop and a winding gully. Carve, tuck and land it clean.",
      daysAgo: 1,
    },
  ],
  es: [
    {
      slug: "welcome",
      title: "Te damos la bienvenida a Costa Nevada",
      body: "Una costa donde la playa y las pistas de esquí están muy cerca. Cada estación trae un deporte distinto: moto de agua en verano, snowboard en invierno, y más por llegar.\n\nCompite con tus amigos en una sala privada o entra en el emparejamiento.",
      daysAgo: 2,
    },
    {
      slug: "mountain-run",
      title: "La bajada de la montaña está abierta",
      body: "Del refugio de la cima al pueblo: pistas abiertas, ondulaciones y mesas, curvas entre árboles, un cortado y un barranco con curvas. Traza, agáchate y aterriza limpio.",
      daysAgo: 1,
    },
  ],
  ca: [
    {
      slug: "welcome",
      title: "Et donem la benvinguda a Costa Nevada",
      body: "Una costa on la platja i les pistes d'esquí són molt a prop. Cada estació porta un esport diferent: moto d'aigua a l'estiu, snowboard a l'hivern, i més que en vindran.\n\nCompeteix amb els teus amics en una sala privada o entra a l'emparellament.",
      daysAgo: 2,
    },
    {
      slug: "mountain-run",
      title: "La baixada de la muntanya és oberta",
      body: "Del refugi del cim al poble: pistes obertes, ondulacions i taules, revolts entre arbres, un cingle i un barranc amb revolts. Traça, ajup-te i aterra net.",
      daysAgo: 1,
    },
  ],
};

const pool = new Pool({ connectionString: url, max: 1 });
const db = drizzle(pool);
try {
  const [banners] = await db.select({ n: count() }).from(banner);
  if (banners?.n === 0) {
    await db
      .insert(banner)
      .values(
        Object.entries(BANNERS).flatMap(([locale, list]) =>
          list.map((b, sort) => ({ ...b, locale, sort, published: true })),
        ),
      );
  }
  const [posts] = await db.select({ n: count() }).from(newsPost);
  if (posts?.n === 0) {
    const day = 24 * 60 * 60 * 1000;
    await db
      .insert(newsPost)
      .values(
        Object.entries(NEWS).flatMap(([locale, list]) =>
          list.map(({ daysAgo, ...n }) => ({ ...n, locale, publishedAt: new Date(Date.now() - daysAgo * day) })),
        ),
      );
  }
} finally {
  await pool.end();
}

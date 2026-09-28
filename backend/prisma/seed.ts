import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Основные регионы Яндекса (lr). Полный справочник — geobase Яндекса.
const REGIONS: { code: number; name: string; parent?: number }[] = [
  { code: 225, name: 'Россия' },
  { code: 213, name: 'Москва', parent: 225 },
  { code: 2, name: 'Санкт-Петербург', parent: 225 },
  { code: 65, name: 'Новосибирск', parent: 225 },
  { code: 54, name: 'Екатеринбург', parent: 225 },
  { code: 43, name: 'Казань', parent: 225 },
  { code: 47, name: 'Нижний Новгород', parent: 225 },
  { code: 35, name: 'Краснодар', parent: 225 },
  { code: 39, name: 'Ростов-на-Дону', parent: 225 },
  { code: 51, name: 'Самара', parent: 225 },
  { code: 172, name: 'Уфа', parent: 225 },
  { code: 56, name: 'Челябинск', parent: 225 },
  { code: 50, name: 'Пермь', parent: 225 },
  { code: 193, name: 'Воронеж', parent: 225 },
  { code: 38, name: 'Волгоград', parent: 225 },
];

async function main() {
  for (const r of REGIONS) {
    await prisma.region.upsert({ where: { code: r.code }, update: { name: r.name, parent: r.parent }, create: r });
  }
  console.log(`Засеяно регионов: ${REGIONS.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

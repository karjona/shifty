// The courses (`sim::CourseId`) by name, in the player's language.
import { messages } from "../i18n/index.ts";

/** The course's name (`sim::CourseId`). */
export function courseName(course: number): string {
  const c = messages().intro.courses;
  return course === 3 ? c.glades : course === 1 ? c.mountain : c.bay;
}

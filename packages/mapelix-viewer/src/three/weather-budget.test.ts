import { expect, it } from "vitest";
import { WeatherBudget } from "./weather-budget";

function run(budget: WeatherBudget, fps: number, seconds: number) {
  for (let i = 0; i < fps * seconds; i++) budget.sample(1 / fps);
}

it("reduces rain below 32 fps, pauses below 18 and recovers in stable stages", () => {
  const budget = new WeatherBudget();
  run(budget, 25, 3);
  expect(budget.quality).toBe(1);
  run(budget, 10, 5);
  expect(budget.quality).toBe(0);
  run(budget, 60, 3);
  expect(budget.quality).toBe(0);
  run(budget, 60, 9);
  expect(budget.quality).toBe(1);
  run(budget, 60, 9);
  expect(budget.quality).toBe(2);
});

it("holds a reduced budget at middling rates and ignores suspended/invalid frames", () => {
  const budget = new WeatherBudget();
  run(budget, 25, 3);
  run(budget, 40, 12);
  expect(budget.quality).toBe(1);
  for (const delta of [0, -1, NaN, Infinity]) budget.sample(delta);
  expect(budget.quality).toBe(1);
});

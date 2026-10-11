# Changelog / Журнал изменений

## 1.1.0 - 2026-10-11

**EN**

- Fix: "infinite nitro". The supply refills a little on every physics step (0.012 per second
  in a race, 0.02 in free roam), and any supply above zero switched the full boost on, so with
  the button held the bar stayed empty while the car kept accelerating. An empty bottle is now
  locked until it refills to 10%; the bar is dimmed while locked.
- New: car damage with a setting in Settings → Game: Off, Visual only (default), Full. Dents
  where the car is hit, mirrors, bumpers and the hood fly off and lie on the road; Full adds
  tyre wear, a steering pull after a hit to a front wheel and less power with a crushed front,
  with a car and tyre diagram on the HUD. Career events and time trials always use Visual
  only. Repair: a new race, the festival or G in free roam. With Off and Visual only the
  physics is bit-for-bit the same as in 1.0.
- Tests: 3 nitro laws and 13 damage laws (104 laws of the game in total).

**RU**

- Исправлено «бесконечное нитро». Запас понемногу пополняется на каждом шаге физики (0.012 в
  секунду в заезде, 0.02 в свободной езде), а толчок включался целиком при любом запасе больше
  нуля: с зажатой кнопкой полоса стояла пустой, а машина разгонялась без конца. Теперь пустой
  баллон заперт, пока запас не вернётся к 10%; запертая полоса тусклая.
- Новое: повреждения машин и настройка «Настройки» → «Игра»: Выкл, Только вид (по умолчанию),
  Полные. Вмятины в месте удара, отлетающие зеркала, бамперы и капот на дороге; «Полные» - ещё
  износ шин, увод руля после удара в переднее колесо и потеря мощности со смятым передом, на HUD
  схема кузова и шин. В карьере и заездах на время всегда «Только вид». Ремонт: новый заезд,
  фестиваль или G в свободной езде. С «Выкл» и «Только вид» физика бит в бит как в 1.0.
- Проверки: 3 закона нитро и 13 законов повреждений (всего у игры 104 закона).

## 1.0.0 - 2026-10-03

- First version as its own repository: career, 8 cars, 8 tracks, free roam on 4 maps.
- Первая версия отдельным репозиторием: карьера, 8 машин, 8 трасс, свободная езда по 4 картам.

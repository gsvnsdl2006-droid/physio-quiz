# Physio Quest LIVE

A live multiplayer physiotherapy quiz built for groups. The host runs the game from one screen, and up to 100 players can join on their phones. The original 30-question bank includes anatomy, movement, riddles, visual clues, and Lebanese Arabic rounds.

## Run the game

Use Node.js 18 or later:

```bash
npm ci
npm start
```

Open `http://localhost:3000`. Choose **Host game** and pick 10, 20, or 30 questions. Every game ends with the Final Boss. For phones on the same local network, open the host computer’s reachable LAN address with port 3000. For remote players, use the same public URL on a Node.js host that supports Socket.IO. The server honors the `PORT` environment variable.

## Play a round

1. The host shares the six-digit PIN or invite link.
2. Each player enters a nickname and taps **I’m ready**. Once all connected players are ready, the host can start.
3. Everyone can lock in one answer. The answer, explanation, and live scores appear at the deadline or when all connected players have answered.
4. The host advances when the group is ready. The final leaderboard shows shared places for ties.

| Round | Points for a correct answer |
| --- | --- |
| Regular, visual, riddle, and Lebanese Arabic | 1,000 |
| Speed | 1,000, plus 1,000 for the first correct answer |
| Buzzer | 1,000, plus 500 for the first correct answer. The first player to lock any answer is announced during the round. |
| Beat the fuse | 1,000, plus 500 for answering within the first 70% of the timer |
| Final Boss | 2,000 |

A streak adds 200 points to each correct answer from the third in a row. Incorrect or missed answers reset the streak.

Players and the host can reload the same tab to reconnect. New seats can join before the first question. Rooms live in memory on a single server instance and expire after three hours or when the server restarts. Edit `questions.json` to customize the bank.

## Deploy on Render

Connect this repository in Render using **New → Blueprint**. Render reads
`render.yaml` and creates a single Node web service. Once the deploy is live,
open its HTTPS URL, create a room, and share that URL and PIN with players.

The free service can sleep when idle. Open the app before inviting players so
it has time to start. A restart clears active rooms and scores.

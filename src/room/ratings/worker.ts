import { parentPort, workerData } from 'node:worker_threads';
import { fitRatings, type RankedSeat } from './bt.ts';

parentPort!.postMessage(fitRatings(workerData as RankedSeat[][]));

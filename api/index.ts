import * as dotenv from 'dotenv';
dotenv.config();
import { startApiServer } from './server';

const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3001;
startApiServer(port);

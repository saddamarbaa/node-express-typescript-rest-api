import app from '@src/app';
import { environmentConfig } from '@src/configs/custom-environment-variables.config';
import { connectDB } from '@src/configs/db.config';

// Connecting to MongoDB and Starting Server
const start = async () => {
  try {
    await connectDB(environmentConfig.MONGODB_CONNECTION_STRING);

    console.log('MongoDB database connection established successfully to... ');

    app?.listen(process.env.PORT || 3000, () => {
      console.log(`Listening: http://localhost:${process.env.PORT || 3000}`);
    });
  } catch (error) {
    console.log('MongoDB connection error. Please make sure MongoDB is running: ');
  }
};

// Establish http server connection
start();

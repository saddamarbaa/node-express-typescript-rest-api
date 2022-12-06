import { NextFunction, Request, RequestHandler, Response } from 'express';
import createHttpError, { InternalServerError } from 'http-errors';
import { SignOptions } from 'jsonwebtoken';

import User from '@src/models/User.model';
import Token from '@src/models/Token.model';
import {
  isValidMongooseObjectId,
  response,
  sendConfirmResetPasswordEmail,
  sendEmailVerificationEmail,
  sendResetPasswordEmail,
} from '@src/utils';
import { AuthenticatedRequestBody, IUser, ResponseT } from '@src/interfaces';
import { environmentConfig } from '@src/configs/custom-environment-variables.config';
import { verifyRefreshToken } from '@src/middlewares';

export const signupService = async (req: Request, res: Response<ResponseT<null>>, next: NextFunction) => {
  const { email, password, name, confirmPassword, acceptTerms } = req.body;
  const role = environmentConfig?.ADMIN_EMAIL?.includes(`${email}`) ? 'admin' : 'user';
  // const status = environmentConfig?.ADMIN_EMAIL?.includes(`${email}`) ? 'active' : 'pending';

  // const isVerified = !!environmentConfig?.ADMIN_EMAIL?.includes(`${email}`);

  const newUser = new User({
    name,
    email,
    password,
    confirmPassword,
    role,
    // status,
    acceptTerms: acceptTerms || !!environmentConfig?.ADMIN_EMAIL?.includes(`${email}`),
    // isVerified,
  });

  try {
    const isEmailExit = await User.findOne({ email: new RegExp(`^${email}$`, 'i') });
    if (isEmailExit) {
      return next(createHttpError(422, `E-Mail address ${email} is already exists, please pick a different one.`));
    }

    const user = await newUser.save();
    let token = await new Token({ userId: user._id });

    const payload = {
      userId: user._id,
    };

    const accessTokenSecretKey = environmentConfig.ACCESS_TOKEN_SECRET_KEY as string;
    const accessTokenOptions: SignOptions = {
      expiresIn: environmentConfig.ACCESS_TOKEN_KEY_EXPIRE_TIME,
      issuer: environmentConfig.JWT_ISSUER,
      audience: String(user._id),
    };

    const refreshTokenSecretKey = environmentConfig.REFRESH_TOKEN_SECRET_KEY as string;
    const refreshTokenJwtOptions: SignOptions = {
      expiresIn: environmentConfig.REFRESH_TOKEN_KEY_EXPIRE_TIME,
      issuer: environmentConfig.JWT_ISSUER,
      audience: String(user._id),
    };

    // Generate and set verify email token
    const generatedAccessToken = await token.generateToken(payload, accessTokenSecretKey, accessTokenOptions);
    const generatedRefreshToken = await token.generateToken(payload, refreshTokenSecretKey, refreshTokenJwtOptions);

    // Save the updated token
    token.refreshToken = generatedRefreshToken;
    token.accessToken = generatedAccessToken;
    token = await token.save();

    const verifyEmailLink = `${environmentConfig.CLIENT_URL}/verify-email.html?id=${user._id}&token=${token.refreshToken}`;

    // send mail for email verification
    sendEmailVerificationEmail(email, name, verifyEmailLink);

    const data = {
      user: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        verifyEmailLink,
      },
    };

    return res.status(201).json(
      response<any>({
        data,
        success: true,
        error: false,
        message: `Auth Signup is success. An Email with Verification link has been sent to your account ${user.email} Please Verify Your Email first or use the email verification lik which is been send with the response body to verfiy your email`,
        status: 201,
      })
    );
  } catch (error) {
    return next(error);
  }
};

export const loginService = async (req: Request, res: Response, next: NextFunction) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email: new RegExp(`^${email}$`, 'i') });

    // 401 Unauthorized
    if (!user) {
      return next(createHttpError(404, 'Auth Failed (Invalid Credentials)'));
    }

    // Compare password
    const isPasswordCorrect = await user.comparePassword(password);

    if (!isPasswordCorrect) {
      return next(createHttpError(401, 'Auth Failed (Invalid Credentials)'));
    }

    let token = await Token.findOne({ userId: user._id });

    if (!token) {
      token = await new Token({ userId: user._id });
      token = await token.save();
    }

    const generatedAccessToken = await token.generateToken(
      {
        userId: user._id,
      },
      environmentConfig.ACCESS_TOKEN_SECRET_KEY,
      {
        expiresIn: environmentConfig.ACCESS_TOKEN_KEY_EXPIRE_TIME,
        issuer: environmentConfig.JWT_ISSUER,
        audience: String(user._id),
      }
    );
    const generatedRefreshToken = await token.generateToken(
      {
        userId: user._id,
      },
      environmentConfig.REFRESH_TOKEN_SECRET_KEY,
      {
        expiresIn: environmentConfig.REFRESH_TOKEN_KEY_EXPIRE_TIME,
        issuer: environmentConfig.JWT_ISSUER,
        audience: String(user._id),
      }
    );

    // Save the updated token
    token.refreshToken = generatedRefreshToken;
    token.accessToken = generatedAccessToken;
    token = await token.save();

    // check user is verified or not
    if (!user.isVerified || user.status !== 'active') {
      const verifyEmailLink = `${environmentConfig.CLIENT_URL}/verify-email.html?id=${user._id}&token=${token.refreshToken}`;

      // Again send verification email
      sendEmailVerificationEmail(email, user.name, verifyEmailLink);

      const responseData = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        verifyEmailLink,
      };

      return res.status(401).json(
        response<typeof responseData>({
          data: responseData,
          success: false,
          error: true,
          message: `Your Email has not been verified. An Email with Verification link has been sent to your account ${user.email} Please Verify Your Email first or use the email verification lik which is been send with the response to verfiy your email`,
          status: 401,
        })
      );
    }

    // Response data
    const data = {
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user?.role,
        isVerified: user?.isVerified,
        isDeleted: user?.isDeleted,
        status: user?.status,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
      },
    };

    // Set cookies
    res.cookie('accessToken', token.accessToken, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // one days
      secure: process.env.NODE_ENV === 'production',
    });

    res.cookie('refreshToken', token.refreshToken, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: process.env.NODE_ENV === 'production',
    });

    // Set refreshToken' AND accessToken IN cookies
    return res.status(200).json(
      response<typeof data>({
        data,
        success: true,
        error: false,
        message: 'Auth logged in successful.',
        status: 200,
      })
    );
  } catch (error) {
    return next(error);
  }
};

export const verifyEmailService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user)
      return next(
        createHttpError(
          400,
          'Email verification token is invalid or has expired. Please click on resend for verify your Email.'
        )
      );

    // user is already verified
    if (user.isVerified && user.status === 'active') {
      return res.status(200).send(
        response<null>({
          data: null,
          success: true,
          error: false,
          message: `User has already been verified. Please Login..`,
          status: 200,
        })
      );
    }

    const emailVerificationToken = await Token.findOne({
      userId: user._id,
      refreshToken: req.params.token,
    });

    if (!emailVerificationToken) {
      return next(createHttpError(400, 'Email verification token is invalid or has expired.'));
    }
    // Verfiy the user
    user.isVerified = true;
    user.status = 'active';
    user.acceptTerms = true;
    await user.save();
    await emailVerificationToken.delete();

    return res.status(200).json(
      response<null>({
        data: null,
        success: true,
        error: false,
        message: 'Your account has been successfully verified . Please Login. ',
        status: 200,
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export const logoutService: RequestHandler = async (req, res, next) => {
  const { refreshToken } = req.body;

  try {
    const token = await Token.findOne({
      refreshToken,
    });

    if (!token) {
      return next(new createHttpError.BadRequest());
    }

    const userId = await verifyRefreshToken(refreshToken);

    if (!userId) {
      return next(new createHttpError.BadRequest());
    }

    // Clear Token
    await Token.deleteOne({
      refreshToken,
    });

    // Clear cookies
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');

    return res.status(200).json(
      response<null>({
        data: null,
        success: true,
        error: false,
        message: 'Successfully logged out 😏 🍀',
        status: 200,
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export const updateAuthService = async (req: AuthenticatedRequestBody<IUser>, res: Response, next: NextFunction) => {
  if (!isValidMongooseObjectId(req.params.userId) || !req.params.userId) {
    return next(createHttpError(422, `Invalid request`));
  }

  const {
    name,
    firstName,
    lastName,
    email,
    dateOfBirth,
    gender,
    familyName,
    mobileNumber,
    status,
    role,
    bio,
    acceptTerms,
    companyName,
    nationality,
    address,
    favoriteAnimal,
    jobTitle,
  } = req.body;

  try {
    const user = await User.findById(req.params.userId);

    if (!user) {
      return next(new createHttpError.BadRequest());
    }

    if (!req.user?._id.equals(user._id) && req?.user?.role !== 'admin') {
      return next(createHttpError(403, `Auth Failed (Unauthorized)`));
    }

    if (email) {
      const existingUser = await User.findOne({ email: new RegExp(`^${email}$`, 'i') });
      if (existingUser && !existingUser._id.equals(user._id)) {
        return next(createHttpError(422, `E-Mail address ${email} is already exists, please pick a different one.`));
      }
    }

    user.name = name || user.name;
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.email = email || user.email;
    user.gender = gender || user.gender;
    user.dateOfBirth = dateOfBirth || user.dateOfBirth;
    user.familyName = familyName || user.familyName;
    user.mobileNumber = mobileNumber || user.mobileNumber;
    user.status = status || user.status;
    user.role = role || user.role;
    user.acceptTerms = acceptTerms || user.acceptTerms;
    user.bio = bio || user.bio;
    user.familyName = familyName || user.familyName;
    user.acceptTerms = acceptTerms || user.acceptTerms;
    user.companyName = companyName || user.companyName;
    user.nationality = nationality || user.nationality;
    user.address = address || user.address;
    user.jobTitle = jobTitle || user.jobTitle;
    user.favoriteAnimal = favoriteAnimal || user.favoriteAnimal;
    user.profileImage = req.file?.filename ? `/static/uploads/users/${req.file.filename}` : user.profileImage;

    const updatedUser = await user.save();

    if (!updatedUser) {
      return next(createHttpError(422, `Failed to update user by given ID ${req.params.userId}`));
    }

    const data = {
      user: {
        _id: updatedUser._id,
        name: updatedUser.name,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        email: updatedUser.email,
        dateOfBirth: updatedUser.dateOfBirth,
        gender: updatedUser.gender,
        createdAt: updatedUser?.createdAt,
        updatedAt: updatedUser?.updatedAt,
        role: updatedUser?.role,
        status: updatedUser.status,
        mobileNumber: updatedUser?.mobileNumber,
        familyName: updatedUser?.familyName,
        profileImage: updatedUser?.profileImage,
        isVerified: updatedUser?.isVerified,
        acceptTerms: updatedUser?.acceptTerms,
        bio: updatedUser.bio,
        companyName: updatedUser.companyName,
        nationality: updatedUser.nationality,
        address: updatedUser.address,
        favoriteAnimal: updatedUser.favoriteAnimal,
      },
    };

    return res.status(200).json(
      response<typeof data>({
        data,
        success: true,
        error: false,
        message: `Successfully updated user by ID: ${req.params.userId}`,
        status: 200,
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export const removeAuthService = async (req: AuthenticatedRequestBody<IUser>, res: Response, next: NextFunction) => {
  if (!isValidMongooseObjectId(req.params.userId) || !req.params.userId) {
    return next(createHttpError(422, `Invalid request`));
  }

  try {
    const user = await User.findById(req.params.userId);

    if (!user) {
      return next(new createHttpError.BadRequest());
    }

    if (!req.user?._id.equals(user._id) && req?.user?.role !== 'admin') {
      return next(createHttpError(403, `Auth Failed (Unauthorized)`));
    }

    const deletedUser = await User.findByIdAndRemove({
      _id: req.params.userId,
    });

    if (!deletedUser) {
      return next(createHttpError(422, `Failed to delete user by given ID ${req.params.userId}`));
    }

    return res.status(200).json(
      response<null>({
        data: null,
        success: true,
        error: false,
        message: `Successfully deleted user by ID ${req.params.userId}`,
        status: 200,
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export const getAuthProfileService = async (
  req: AuthenticatedRequestBody<IUser>,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = await User.findById(req?.user?._id);

    if (!user) {
      return next(createHttpError(401, `Auth Failed `));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, confirmPassword, ...otherUserInfo } = user._doc;

    return res.status(200).send(
      response<{ user: IUser }>({
        success: true,
        error: false,
        message: 'Successfully found user profile 🍀',
        status: 200,
        data: { user: otherUserInfo },
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export const refreshTokenService: RequestHandler = async (req, res, next) => {
  const { refreshToken } = req.body;

  try {
    let token = await Token.findOne({
      refreshToken,
    });

    if (!token) {
      return next(new createHttpError.BadRequest());
    }

    const userId = await verifyRefreshToken(refreshToken);

    if (!userId) {
      return next(new createHttpError.BadRequest());
    }

    const generatedAccessToken = await token.generateToken(
      {
        userId,
      },
      environmentConfig.ACCESS_TOKEN_SECRET_KEY,
      {
        expiresIn: environmentConfig.ACCESS_TOKEN_KEY_EXPIRE_TIME,
        issuer: environmentConfig.JWT_ISSUER,
        audience: String(userId),
      }
    );
    const generatedRefreshToken = await token.generateToken(
      {
        userId,
      },
      environmentConfig.REFRESH_TOKEN_SECRET_KEY,
      {
        expiresIn: environmentConfig.REFRESH_TOKEN_KEY_EXPIRE_TIME,
        issuer: environmentConfig.JWT_ISSUER,
        audience: String(userId),
      }
    );

    // Save the updated token
    token.refreshToken = generatedRefreshToken;
    token.accessToken = generatedAccessToken;
    token = await token.save();

    // Response data
    const data = {
      user: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
      },
    };

    // Set cookies
    res.cookie('accessToken', token.accessToken, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // one days
      secure: process.env.NODE_ENV === 'production',
    });

    res.cookie('refreshToken', token.refreshToken, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: process.env.NODE_ENV === 'production',
    });

    // Set refreshToken' AND accessToken IN cookies
    return res.status(200).json(
      response<typeof data>({
        data,
        success: true,
        error: false,
        message: 'Auth logged in successful.',
        status: 200,
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export const sendForgotPasswordMailService: RequestHandler = async (req, res, next) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      const message = `The email address ${email} is not associated with any account. Double-check your email address and try again.`;
      return next(createHttpError(401, message));
    }

    let token = await Token.findOne({ userId: user._id });

    if (!token) {
      token = await new Token({ userId: user._id });
      token = await token.save();
    }

    const generatedAccessToken = await token.generateToken(
      {
        userId: user._id,
      },
      environmentConfig.ACCESS_TOKEN_SECRET_KEY,
      {
        expiresIn: environmentConfig.ACCESS_TOKEN_KEY_EXPIRE_TIME,
        issuer: environmentConfig.JWT_ISSUER,
        audience: String(user._id),
      }
    );
    const generatedRefreshToken = await token.generateToken(
      {
        userId: user._id,
      },
      environmentConfig.REFRESH_TOKEN_SECRET_KEY,
      {
        expiresIn: environmentConfig.REST_PASSWORD_LINK_EXPIRE_TIME,
        issuer: environmentConfig.JWT_ISSUER,
        audience: String(user._id),
      }
    );

    // Save the updated token
    token.refreshToken = generatedRefreshToken;
    token.accessToken = generatedAccessToken;
    token = await token.save();

    const passwordResetEmailLink = `${environmentConfig.CLIENT_URL}/reset-password.html?id=${user._id}&token=${token.refreshToken}`;

    // password Reset Email
    sendResetPasswordEmail(email, user.name, passwordResetEmailLink);

    const data = {
      user: {
        resetPasswordToken: passwordResetEmailLink,
      },
    };

    return res.status(200).json(
      response<typeof data>({
        data,
        success: true,
        error: false,
        message: `Auth success. An Email with Rest password link has been sent to your account ${email}  please check to rest your password or use the the link which is been send with the response body to rest your password`,
        status: 200,
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export const resetPasswordService: RequestHandler = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return next(createHttpError(401, `Password reset token is invalid or has expired.`));

    const token = await Token.findOne({ userId: req.params.userId, refreshToken: req.params.token });

    if (!token) return next(createHttpError(401, 'Password reset token is invalid or has expired.'));

    const userId = await verifyRefreshToken(req.params.token);

    if (!userId) {
      return next(new createHttpError.BadRequest());
    }

    user.password = req.body.password;
    user.confirmPassword = req.body.confirmPassword;
    await user.save();
    await token.delete();

    const confirmResetPasswordEmailLink = `${environmentConfig.CLIENT_URL}/login.html`;

    sendConfirmResetPasswordEmail(user.email, user.name, confirmResetPasswordEmailLink);

    const data = {
      user: {
        loginLink: confirmResetPasswordEmailLink,
      },
    };

    return res.status(200).json(
      response<typeof data>({
        data,
        success: true,
        error: false,
        message: `Your password has been Password Reset Successfully updated please login`,
        status: 200,
      })
    );
  } catch (error) {
    return next(InternalServerError);
  }
};

export default {
  signupService,
  loginService,
  verifyEmailService,
  refreshTokenService,
  sendForgotPasswordMailService,
  resetPasswordService,
  logoutService,
  removeAuthService,
  updateAuthService,
  getAuthProfileService,
};

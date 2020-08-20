import {
  authenticate,
  AuthenticationBindings,
  UserService,
} from '@loopback/authentication';
import {Getter, inject} from '@loopback/core';
import {
  Count,
  CountSchema,
  Filter,
  FilterExcludingWhere,
  repository,
  Where,
} from '@loopback/repository';
import {
  del,
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
  post,
  put,
  requestBody,
  Response,
  RestBindings,
} from '@loopback/rest';
import {UserProfile} from '@loopback/security';
import {
  PasswordHasherBindings,
  TokenServiceBindings,
  UserServiceBindings,
} from '../components/jwt-authentication/keys';
import {JWTService} from '../components/jwt-authentication/services';
import {PasswordHasher} from '../components/jwt-authentication/services/hash.password.bcryptjs';
import {MyUserProfile} from '../components/jwt-authentication/types';
import {Email, User} from '../models';
import {CredentialRepository, UserRepository} from '../repositories';
import {CredentialSchema, OTPCredentialSchema, SignUpSchema} from '../schema';
import {ForgetPasswordSchema} from '../schema/forget-password.schema';
import {EmailService, OtpService, SmsTac, XmlToJsonService} from '../services';
import {ForgetPassword, OTPCredential} from '../types';
import {Credentials} from '../types/credential.types';
import {OPERATION_SECURITY_SPEC} from './../components/jwt-authentication';

export class UserController {
  constructor(
    @repository(UserRepository)
    public userRepository: UserRepository,
    @repository(CredentialRepository)
    public credentialRepository: CredentialRepository,
    @inject('services.SmsTac') protected smsTacService: SmsTac,
    @inject('services.XmlToJsonService')
    protected xmlToJsonService: XmlToJsonService,
    @inject('services.OtpService') protected otpService: OtpService,
    @inject('services.EmailService') protected emailService: EmailService,
    @inject(TokenServiceBindings.TOKEN_SERVICE)
    public jwtService: JWTService,
    @inject(UserServiceBindings.USER_SERVICE)
    public userService: UserService<User, Credentials>,
    @inject(PasswordHasherBindings.PASSWORD_HASHER)
    public passwordHasher: PasswordHasher,
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    public getCurrentUser: Getter<UserProfile>,
  ) {}

  @post('/user', {
    responses: {
      '200': {
        description: 'User model instance',
        content: {'application/json': {schema: getModelSchemaRef(User)}},
      },
    },
  })
  async create(
    @requestBody({
      required: true,
      content: {
        'application/x-www-form-urlencoded': {schema: SignUpSchema},
      },
    })
    credential: Credentials,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ): Promise<User> {
    const userExisted = await this.userRepository.findOne({
      where: {mobile: credential.mobile},
    });

    if (!userExisted) {
      const userCreated = await this.userRepository.create({
        mobile: credential.mobile,
        email: credential.email,
        name: credential.name,
      });

      const token = this.otpService.getOTPCode();

      // send SMS
      const validity: string = process.env.OTP_VALIDITY ?? '0';
      await this.smsTacService.sendSms(
        credential.mobile,
        `Your verification token is ${token}. Only valid for ${
          parseInt(validity) / 60000
        } minute.`,
        `${token}`,
      );

      await this.credentialRepository.create({
        password: await this.passwordHasher.hashPassword(credential.password),
        userId: userCreated.uuid,
      });

      return userCreated;
    } else {
      throw new HttpErrors.BadRequest('This mobile already exists');
    }
  }

  @get('/user/count', {
    responses: {
      '200': {
        description: 'User model count',
        content: {'application/json': {schema: CountSchema}},
      },
    },
  })
  async count(@param.where(User) where?: Where<User>): Promise<Count> {
    return this.userRepository.count(where);
  }

  @get('/user', {
    responses: {
      '200': {
        description: 'Array of User model instances',
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: getModelSchemaRef(User, {includeRelations: true}),
            },
          },
        },
      },
    },
  })
  async find(@param.filter(User) filter?: Filter<User>): Promise<User[]> {
    return this.userRepository.find(filter);
  }

  @patch('/user', {
    responses: {
      '200': {
        description: 'User PATCH success count',
        content: {'application/json': {schema: CountSchema}},
      },
    },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(User, {partial: true}),
        },
      },
    })
    user: User,
    @param.where(User) where?: Where<User>,
  ): Promise<Count> {
    return this.userRepository.updateAll(user, where);
  }

  @get('/user/{id}', {
    responses: {
      '200': {
        description: 'User model instance',
        content: {
          'application/json': {
            schema: getModelSchemaRef(User, {includeRelations: true}),
          },
        },
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(User, {exclude: 'where'}) filter?: FilterExcludingWhere<User>,
  ): Promise<User> {
    return this.userRepository.findById(id, filter);
  }

  @patch('/user/{id}', {
    responses: {
      '204': {
        description: 'User PATCH success',
      },
    },
  })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(User, {partial: true}),
        },
      },
    })
    user: User,
  ): Promise<void> {
    await this.userRepository.updateById(id, user);
  }

  @put('/user/{id}', {
    responses: {
      '204': {
        description: 'User PUT success',
      },
    },
  })
  async replaceById(
    @param.path.string('id') id: string,
    @requestBody() user: User,
  ): Promise<void> {
    await this.userRepository.replaceById(id, user);
  }

  @del('/user/{id}', {
    responses: {
      '204': {
        description: 'User DELETE success',
      },
    },
  })
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.userRepository.deleteById(id);
  }

  @post('/user/login', {
    responses: {
      '200': {
        description: 'Token',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                token: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
    },
  })
  async login(
    @requestBody({
      required: true,
      content: {
        'application/x-www-form-urlencoded': {schema: CredentialSchema},
      },
    })
    credential: Credentials,
  ): Promise<{token: string}> {
    const user = await this.userService.verifyCredentials(credential);
    const userProfile = this.userService.convertToUserProfile(
      user,
    ) as MyUserProfile;
    const token = await this.jwtService.generateToken(userProfile);

    return {token: token};
  }

  @get('/me', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      '200': {
        description: 'User model instance',
        content: {
          'application/json': {
            schema: getModelSchemaRef(User, {includeRelations: true}),
          },
        },
      },
    },
  })
  @authenticate('jwt')
  async whoAmI(): Promise<UserProfile> {
    return this.getCurrentUser();
  }

  @post('/user/verify', {
    responses: {
      '200': {
        description: 'User model instance',
      },
    },
  })
  @authenticate('jwt')
  async verifyOTPToken(
    @requestBody({
      required: true,
      content: {
        'application/x-www-form-urlencoded': {schema: OTPCredentialSchema},
      },
    })
    otpCredential: OTPCredential,
  ): Promise<User> {
    let bRetCode = false;

    const user = await this.getCurrentUser();
    const userCred = await this.userRepository.findCredentials(user.user);

    if (userCred?.tokenCreatedAt) {
      bRetCode = this.otpService.verifyOTP(
        otpCredential.otp,
        userCred.tokenCreatedAt,
      );
    }

    if (!bRetCode) {
      throw new HttpErrors.BadRequest('Invalid credentials');
    }

    return this.userRepository.findById(user.user);
  }

  // @post('/user/otp/refresh', {
  //   responses: {
  //     '200': {
  //       description: 'User model instance',
  //     },
  //   },
  // })
  // @authenticate('jwt')
  // async refreshOtp(): Promise<{refresh: Boolean}> {
  //   const bRetCode = true;

  //   const token = this.otpService.getOTPCode();

  //   await this.credentialRepository.updateById(user.user, {
  //     password: await this.passwordHasher.hashPassword(credential.password),
  //     token: token,
  //     userId: userCreated.uuid,
  //   });

  //   return {refresh: bRetCode};
  // }

  @get('/user/forget/{mobile}', {
    responses: {
      '200': {
        description: 'Forget password',
      },
    },
  })
  async forgetPassword(
    @param.path.string('mobile') mobile: string,
  ): Promise<{result: Boolean; token: string}> {
    let bRetCode = false;
    const userExisted = await this.userRepository.findOne({
      where: {mobile: mobile},
    });

    if (!userExisted) {
      throw new HttpErrors.Unauthorized('No valid users');
    } else {
      bRetCode = true;
    }

    const token = await this.jwtService.generateResetPasswordToken(userExisted);

    const email = new Email({
      to: 'balainkk@gmail.com',
      subject: 'test',
      content: token,
    });

    await this.emailService.sendMail(email);

    return {result: bRetCode, token: token};
  }

  @post('/user/forget', {
    responses: {
      '200': {
        description: 'Forget password',
      },
    },
  })
  async setNewPassword(
    @requestBody({
      required: true,
      content: {
        'application/x-www-form-urlencoded': {schema: ForgetPasswordSchema},
      },
    })
    forget: ForgetPassword,
  ): Promise<{result: Boolean}> {
    const userId = await this.jwtService.decodeResetPasswordToken(forget.token);
    const credential = await this.userRepository.findCredentials(userId);

    if (!credential) {
      throw new HttpErrors.Unauthorized('Invalid forget password token');
    } else {
      credential.password = await this.passwordHasher.hashPassword(
        forget.password,
      );
      credential.resetToken = '';

      await this.credentialRepository.update(credential);
    }

    return {result: true};
  }
}

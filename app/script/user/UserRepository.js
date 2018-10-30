/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

'use strict';

window.z = window.z || {};
window.z.user = z.user || {};

z.user.UserRepository = class UserRepository {
  static get CONFIG() {
    return {
      SUPPORTED_EVENTS: [z.event.Backend.USER.AVAILABILITY, z.event.Backend.USER.DELETE, z.event.Backend.USER.UPDATE],
    };
  }

  /**
   * Construct a new User repository.
   * @class z.user.UserRepository
   * @param {z.user.UserService} user_service - Backend REST API user service implementation
   * @param {z.client.ClientRepository} client_repository - Repository for all client interactions
   * @param {z.self.SelfRepository} selfRepository - Repository for all self interactions
   * @param {z.time.ServerTimeRepository} serverTimeRepository - Handles time shift between server and client
   */
  constructor(user_service, client_repository, selfRepository, serverTimeRepository) {
    this.user_service = user_service;
    this.client_repository = client_repository;
    this.selfRepository = selfRepository;
    this.logger = new z.util.Logger('z.user.UserRepository', z.config.LOGGER.OPTIONS);

    this.user_mapper = new z.user.UserMapper(serverTimeRepository);

    this.selfUser = this.selfRepository.selfUser;
    this.users = ko.observableArray([]);

    this.connect_requests = ko
      .pureComputed(() => {
        return this.users().filter(user_et => user_et.isIncomingRequest());
      })
      .extend({rateLimit: 50});

    this.connected_users = ko
      .pureComputed(() => {
        return this.users()
          .filter(user_et => user_et.isConnected())
          .sort((user_a, user_b) => z.util.StringUtil.sortByPriority(user_a.first_name(), user_b.first_name()));
      })
      .extend({rateLimit: z.util.TimeUtil.UNITS_IN_MILLIS.SECOND});

    this.isTeam = ko.observable();
    this.teamMembers = undefined;
    this.teamUsers = undefined;

    this.number_of_contacts = ko.pureComputed(() => {
      const contacts = this.isTeam() ? this.teamUsers() : this.connected_users();
      return contacts.filter(user_et => !user_et.isService).length;
    });
    this.number_of_contacts.subscribe(number_of_contacts => {
      amplify.publish(z.event.WebApp.ANALYTICS.SUPER_PROPERTY, z.tracking.SuperProperty.CONTACTS, number_of_contacts);
    });

    amplify.subscribe(z.event.WebApp.CLIENT.ADD, this.addClientToUser.bind(this));
    amplify.subscribe(z.event.WebApp.CLIENT.REMOVE, this.remove_client_from_user.bind(this));
    amplify.subscribe(z.event.WebApp.CLIENT.UPDATE, this.update_clients_from_user.bind(this));
    amplify.subscribe(z.event.WebApp.USER.EVENT_FROM_BACKEND, this.onUserEvent.bind(this));
    amplify.subscribe(z.event.WebApp.USER.PERSIST, this.saveUserInDb.bind(this));
    amplify.subscribe(z.event.WebApp.USER.UPDATE, this.updateUserById.bind(this));
  }

  /**
   * Listener for incoming user events.
   *
   * @param {Object} eventJson - JSON data for event
   * @param {z.event.EventRepository.SOURCE} source - Source of event
   * @returns {undefined} No return value
   */
  onUserEvent(eventJson, source) {
    const eventType = eventJson.type;
    const isSupportedEvent = UserRepository.CONFIG.SUPPORTED_EVENTS.includes(eventType);

    if (isSupportedEvent) {
      const logObject = {eventJson: JSON.stringify(eventJson), eventObject: eventJson};
      this.logger.info(`»» User Event: '${eventType}' (Source: ${source})`, logObject);

      const isUserAvailability = eventType === z.event.Backend.USER.AVAILABILITY;
      if (isUserAvailability) {
        return this.onUserAvailability(eventJson);
      }

      const isUserDelete = eventType === z.event.Backend.USER.DELETE;
      if (isUserDelete) {
        return this.onUserDelete(eventJson);
      }

      const isUserUpdate = eventType === z.event.Backend.USER.UPDATE;
      if (isUserUpdate) {
        return this.onUserUpdate(eventJson);
      }
    }
  }

  loadUsers() {
    if (this.isTeam()) {
      return this.user_service
        .loadUserFromDb()
        .then(users => {
          if (users.length) {
            this.logger.log(`Loaded state of '${users.length}' users from database`, users);

            const mappingPromises = users.map(user => {
              return this.get_user_by_id(user.id).then(userEntity => userEntity.availability(user.availability));
            });

            return Promise.all(mappingPromises);
          }
        })
        .then(() => this.users().forEach(userEntity => userEntity.subscribeToChanges()));
    }
  }

  /**
   * Persists a conversation state in the database.
   * @param {User} userEntity - User which should be persisted
   * @returns {Promise} Resolves when user was saved
   */
  saveUserInDb(userEntity) {
    return this.user_service.saveUserInDb(userEntity);
  }

  /**
   * Event to update availability of user.
   * @param {Object} event - Event data
   * @returns {undefined} No return value
   */
  onUserAvailability(event) {
    if (this.isTeam()) {
      const {
        from: userId,
        data: {availability},
      } = event;
      this.get_user_by_id(userId).then(userEntity => userEntity.availability(availability));
    }
  }

  /**
   * Event to delete the matching user.
   * @param {string} id - User ID of deleted user
   * @returns {undefined} No return value
   */
  onUserDelete({id: userId}) {
    const isSelfUser = userId === this.selfUser().id;
    if (!isSelfUser) {
      this.logger.info(`Remote user '${userId}' was deleted`);
    }
  }

  /**
   * Event to update the matching user.
   * @param {Object} user - Update user info
   * @returns {Promise} Resolves wit the updated user entity
   */
  onUserUpdate({user: userData}) {
    const isSelfUser = userData.id === this.selfUser().id;
    if (!isSelfUser) {
      return this.get_user_by_id(userData.id).then(userEntity => {
        return this.user_mapper.updateUserFromObject(userEntity, userData);
      });
    }
  }

  /**
   * Update users matching the given connections.
   * @param {Array<z.connection.ConnectionEntity>} connectionEntities - Connection entities
   * @returns {Promise<Array<z.connection.ConnectionEntity>>} Promise that resolves when all connections have been updated
   */
  updateUsersFromConnections(connectionEntities) {
    const userIds = connectionEntities.map(connectionEntity => connectionEntity.userId);
    return this.get_users_by_id(userIds).then(userEntities => {
      userEntities.forEach(userEntity => {
        const connectionEntity = connectionEntities.find(({userId}) => userId === userEntity.id);
        userEntity.connection(connectionEntity);
      });
      return this._assignAllClients();
    });
  }

  /**
   * Assign all locally stored clients to the users.
   * @private
   * @returns {Promise} Promise that resolves with all user entities where client entities have been assigned to.
   */
  _assignAllClients() {
    return this.client_repository.getAllClientsFromDb().then(recipients => {
      const userIds = Object.keys(recipients);
      this.logger.info(`Found locally stored clients for '${userIds.length}' users`, recipients);

      return this.get_users_by_id(userIds).then(userEntities => {
        userEntities.forEach(userEntity => {
          const clientEntities = recipients[userEntity.id];
          const tooManyClients = clientEntities > 8;
          if (tooManyClients) {
            this.logger.warn(`Found '${clientEntities.length}' clients for '${userEntity.name()}'`, clientEntities);
          }
          userEntity.devices(clientEntities);
        });

        return userEntities;
      });
    });
  }

  /**
   * Saves a new client for the first time to the database and adds it to a user's entity.
   *
   * @param {string} userId - ID of user
   * @param {Object} clientPayload - Payload of client which should be added to user
   * @param {boolean} publishClient - Publish new client
   * @returns {Promise} Promise that resolves when a client and its session have been deleted
   */
  addClientToUser(userId, clientPayload, publishClient = false) {
    return this.get_user_by_id(userId).then(userEntity => {
      const clientEntity = this.client_repository.clientMapper.mapClient(clientPayload, userEntity.is_me);
      const wasClientAdded = userEntity.add_client(clientEntity);

      if (wasClientAdded) {
        return this.client_repository.saveClientInDb(userId, clientEntity.toJson()).then(() => {
          if (publishClient) {
            amplify.publish(z.event.WebApp.USER.CLIENT_ADDED, userId, clientEntity);
          }
        });
      }
    });
  }

  /**
   * Removes a stored client and the session connected with it.
   * @param {string} user_id - ID of user
   * @param {string} client_id - ID of client to be deleted
   * @returns {Promise} Promise that resolves when a client and its session have been deleted
   */
  remove_client_from_user(user_id, client_id) {
    return this.client_repository
      .removeClient(user_id, client_id)
      .then(() => this.get_user_by_id(user_id))
      .then(user_et => {
        user_et.remove_client(client_id);
        amplify.publish(z.event.WebApp.USER.CLIENT_REMOVED, user_id, client_id);
      });
  }

  /**
   * Update clients for given user.
   * @param {string} user_id - ID of user
   * @param {Array<z.client.ClientEntity>} client_ets - Clients which should get updated
   * @returns {undefined} No return value
   */
  update_clients_from_user(user_id, client_ets) {
    this.get_user_by_id(user_id).then(user_et => {
      user_et.devices(client_ets);
      amplify.publish(z.event.WebApp.USER.CLIENTS_UPDATED, user_id, client_ets);
    });
  }

  /**
   * Get a user from the backend.
   * @param {string} userId - User ID
   * @returns {Promise<z.entity.User>} Promise that resolves with the user entity
   */
  fetchUserById(userId) {
    return this.fetchUsersById([userId]).then(([userEntity]) => userEntity);
  }

  /**
   * Get users from the backend.
   * @param {Array<string>} userIds - User IDs
   * @returns {Promise<Array<z.entity.User>>} Promise that resolves with an array of user entities
   */
  fetchUsersById(userIds = []) {
    userIds = userIds.filter(userId => !!userId);

    if (!userIds.length) {
      return Promise.resolve([]);
    }

    const _getUsers = chunkOfUserIds => {
      return this.user_service
        .get_users(chunkOfUserIds)
        .then(response => (response ? this.user_mapper.map_users_from_object(response) : []))
        .catch(error => {
          const isNotFound = error.code === z.error.BackendClientError.STATUS_CODE.NOT_FOUND;
          if (isNotFound) {
            return [];
          }
          throw error;
        });
    };

    const chunksOfUserIds = z.util.ArrayUtil.chunk(userIds, z.config.MAXIMUM_USERS_PER_REQUEST);
    return Promise.all(chunksOfUserIds.map(chunkOfUserIds => _getUsers(chunkOfUserIds)))
      .then(resolveArray => {
        const newUserEntities = _.flatten(resolveArray);

        if (this.isTeam()) {
          this.mapGuestStatus(newUserEntities);
        }

        return this.save_users(newUserEntities);
      })
      .then(fetchedUserEntities => {
        // If there is a difference then we most likely have a case with a suspended user
        const isAllUserIds = userIds.length === fetchedUserEntities.length;
        if (!isAllUserIds) {
          fetchedUserEntities = this._add_suspended_users(userIds, fetchedUserEntities);
        }

        return fetchedUserEntities;
      });
  }

  /**
   * Find a local user.
   * @param {string} userId - User ID
   * @returns {Promise<z.entity.User>} Resolves with the matching user entity
   */
  findUserById(userId) {
    if (!userId) {
      return Promise.reject(new z.error.UserError(z.error.BaseError.TYPE.MISSING_PARAMETER));
    }

    const matchingUserEntity = this.users().find(userEntity => userEntity.id === userId);
    return matchingUserEntity
      ? Promise.resolve(matchingUserEntity)
      : Promise.reject(new z.error.UserError(z.error.UserError.TYPE.USER_NOT_FOUND));
  }

  /**
   * Check for user locally and fetch it from the server otherwise.
   * @param {string} user_id - User ID
   * @returns {Promise<z.entity.User>} Promise that resolves with the matching user entity
   */
  get_user_by_id(user_id) {
    return this.findUserById(user_id)
      .catch(error => {
        const isNotFound = error.type === z.error.UserError.TYPE.USER_NOT_FOUND;
        if (isNotFound) {
          return this.fetchUserById(user_id);
        }
        throw error;
      })
      .catch(error => {
        const isNotFound = error.type === z.error.UserError.TYPE.USER_NOT_FOUND;
        if (!isNotFound) {
          this.logger.error(`Failed to get user '${user_id}': ${error.message}`, error);
        }
        throw error;
      });
  }

  get_user_id_by_handle(handle) {
    return this.user_service
      .get_username(handle.toLowerCase())
      .then(({user: user_id}) => user_id)
      .catch(error => {
        if (error.code !== z.error.BackendClientError.STATUS_CODE.NOT_FOUND) {
          throw error;
        }
      });
  }

  /**
   * Check for users locally and fetch them from the server otherwise.
   * @param {Array<string>} user_ids - User IDs
   * @param {boolean} offline - Should we only look for cached contacts
   * @returns {Promise<Array<z.entity.User>>} Resolves with an array of users
   */
  get_users_by_id(user_ids = [], offline = false) {
    if (!user_ids.length) {
      return Promise.resolve([]);
    }

    const _find_user = user_id => {
      return this.findUserById(user_id).catch(error => {
        if (error.type !== z.error.UserError.TYPE.USER_NOT_FOUND) {
          throw error;
        }
        return user_id;
      });
    };

    const find_users = user_ids.map(user_id => _find_user(user_id));

    return Promise.all(find_users).then(resolve_array => {
      const known_user_ets = resolve_array.filter(array_item => array_item instanceof z.entity.User);
      const unknown_user_ids = resolve_array.filter(array_item => _.isString(array_item));

      if (offline || !unknown_user_ids.length) {
        return known_user_ets;
      }

      return this.fetchUsersById(unknown_user_ids).then(user_ets => known_user_ets.concat(user_ets));
    });
  }

  /**
   * Is the user the logged in user.
   * @param {z.entity.User|string} user_id - User entity or user ID
   * @returns {boolean} Is the user the logged in user
   */
  is_me(user_id) {
    if (!_.isString(user_id)) {
      user_id = user_id.id;
    }
    return this.selfUser().id === user_id;
  }

  /**
   * Is the user the logged in user.
   * @param {z.entity.User|string} user_et - User entity or user ID
   * @returns {Promise} Resolves with the user entity
   */
  save_user(user_et) {
    return this.findUserById(user_et.id).catch(error => {
      if (error.type !== z.error.UserError.TYPE.USER_NOT_FOUND) {
        throw error;
      }
      this.users.push(user_et);
      return user_et;
    });
  }

  /**
   * Save multiple users at once.
   * @param {Array<z.entity.User>} user_ets - Array of user entities to be stored
   * @returns {Promise} Resolves with users passed as parameter
   */
  save_users(user_ets) {
    const _find_users = user_et => {
      return this.findUserById(user_et.id)
        .then(() => undefined)
        .catch(error => {
          if (error.type !== z.error.UserError.TYPE.USER_NOT_FOUND) {
            throw error;
          }
          return user_et;
        });
    };

    const find_users = user_ets.map(user_et => _find_users(user_et));

    return Promise.all(find_users).then(resolve_array => {
      z.util.koArrayPushAll(this.users, resolve_array.filter(user_et => user_et));
      return user_ets;
    });
  }

  /**
   * Update a local user from the backend by ID.
   * @param {string} userId - User ID
   * @returns {Promise} Resolves when user was updated
   */
  updateUserById(userId) {
    const getLocalUser = () =>
      this.findUserById(userId).catch(error => {
        const isNotFound = error.type === z.error.UserError.TYPE.USER_NOT_FOUND;
        if (isNotFound) {
          return new z.entity.User();
        }
        throw error;
      });

    return Promise.all([getLocalUser(userId), this.user_service.get_user_by_id(userId)])
      .then(([localUserEntity, updatedUserData]) =>
        this.user_mapper.updateUserFromObject(localUserEntity, updatedUserData)
      )
      .then(userEntity => {
        if (this.isTeam()) {
          this.mapGuestStatus([userEntity]);
        }
      });
  }

  /**
   * Add user entities for suspended users.
   * @param {Array<string>} user_ids - Requested user IDs
   * @param {Array<z.entity.User>} user_ets - User entities returned by backend
   * @returns {Array<z.entity.User>} User entities to be returned
   */
  _add_suspended_users(user_ids, user_ets) {
    for (const user_id of user_ids) {
      const matching_user_ids = user_ets.find(user_et => user_et.id === user_id);

      if (!matching_user_ids) {
        const user_et = new z.entity.User(user_id);
        user_et.name(z.l10n.text(z.string.nonexistentUser));
        user_ets.push(user_et);
      }
    }
    return user_ets;
  }

  /**
   * Tries to generate a username suggestion.
   * @returns {Promise} Resolves with the username suggestions
   */
  get_username_suggestion() {
    let suggestions = null;

    return Promise.resolve()
      .then(() => {
        suggestions = z.user.UserHandleGenerator.create_suggestions(this.selfUser().name());
        return this.verify_usernames(suggestions);
      })
      .then(([validSuggestion]) => {
        this.should_set_username = true;
        this.selfUser().username(validSuggestion);
      })
      .catch(error => {
        if (error.code === z.error.BackendClientError.STATUS_CODE.NOT_FOUND) {
          this.should_set_username = false;
        }

        throw error;
      });
  }

  /**
   * Verify usernames against the backend.
   * @param {Array} usernames - Username suggestions
   * @returns {Promise<string>} A list with usernames that are not taken.
   */
  verify_usernames(usernames) {
    return this.user_service.check_usernames(usernames);
  }

  /**
   * Verify a username against the backend.
   * @param {string} username - New user name
   * @returns {string} Username which is not taken.
   */
  verify_username(username) {
    return this.user_service
      .check_username(username)
      .catch(({code: error_code}) => {
        if (error_code === z.error.BackendClientError.STATUS_CODE.NOT_FOUND) {
          return username;
        }
        if (error_code === z.error.BackendClientError.STATUS_CODE.BAD_REQUEST) {
          throw new z.error.UserError(z.error.UserError.TYPE.USERNAME_TAKEN);
        }
        throw new z.error.UserError(z.error.UserError.TYPE.REQUEST_FAILURE);
      })
      .then(verified_username => {
        if (verified_username) {
          return verified_username;
        }
        throw new z.error.UserError(z.error.UserError.TYPE.USERNAME_TAKEN);
      });
  }

  mapGuestStatus(userEntities = this.users()) {
    userEntities.forEach(userEntity => {
      if (!userEntity.is_me) {
        const isTeamMember = this.teamMembers().some(teamMember => teamMember.id === userEntity.id);
        const isGuest = !userEntity.isService && !isTeamMember;
        userEntity.isGuest(isGuest);
        userEntity.isTeamMember(isTeamMember);
      }
    });
  }
};

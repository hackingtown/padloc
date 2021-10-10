import { equalCT, Serializable } from "./encoding";
import {
    API,
    RequestMFACodeParams,
    RetrieveMFATokenParams,
    RetrieveMFATokenResponse,
    InitAuthParams,
    InitAuthResponse,
    CreateAccountParams,
    RecoverAccountParams,
    CreateSessionParams,
    GetInviteParams,
    GetAttachmentParams,
    DeleteAttachmentParams,
    GetLegacyDataParams,
    StartRegisterAuthenticatorParams,
    StartRegisterAuthenticatorResponse,
    CompleteRegisterMFAuthenticatorParams,
    CompleteRegisterMFAuthenticatorResponse,
    StartAuthRequestResponse,
    CompleteAuthRequestResponse,
    CompleteAuthRequestParams,
    StartAuthRequestParams,
    CreateKeyStoreEntryParams,
    GetKeyStoreEntryParams,
    AuthInfo,
    UpdateAuthParams,
} from "./api";
import { Storage, VoidStorage } from "./storage";
import { Attachment, AttachmentStorage } from "./attachment";
import { Session, SessionID } from "./session";
import { Account, AccountID } from "./account";
import { Auth, AccountStatus } from "./auth";
import {
    AuthRequest,
    AuthPurpose,
    Authenticator,
    AuthServer,
    AuthType,
    AuthenticatorStatus,
    AuthRequestStatus,
} from "./auth";
import { Request, Response } from "./transport";
import { Err, ErrorCode } from "./error";
import { Vault, VaultID } from "./vault";
import { Org, OrgID, OrgRole } from "./org";
import { Invite } from "./invite";
import { Messenger } from "./messenger";
import { Server as SRPServer, SRPSession } from "./srp";
import { DeviceInfo } from "./platform";
import { getIdFromEmail, uuid } from "./util";
import { InviteCreatedMessage, InviteAcceptedMessage, MemberAddedMessage } from "./messages";
import { loadLanguage } from "@padloc/locale/src/translate";
import { Logger } from "./log";
import { PBES2Container } from "./container";
import { KeyStoreEntry } from "./key-store";
import { Config, ConfigParam } from "./config";
import { Provisioner, ProvisioningStatus, StubProvisioner } from "./provisioning";

/** Server configuration */
export class ServerConfig extends Config {
    /** URL where the client interface is hosted. Used for creating links into the application */
    @ConfigParam()
    clientUrl = "http://localhost:8080";

    /** Email address to report critical errors to */
    @ConfigParam()
    reportErrors = "";

    /** Maximum accepted request age */
    @ConfigParam("number")
    maxRequestAge = 60 * 60 * 1000;

    /** Whether or not to require email verification before creating an account */
    @ConfigParam("boolean")
    verifyEmailOnSignup = true;

    @ConfigParam("string[]")
    defaultAuthTypes: AuthType[] = [AuthType.Email];

    constructor(init: Partial<ServerConfig> = {}) {
        super();
        Object.assign(this, init);
    }
}

/**
 * Request context
 */
export interface Context {
    /** Current [[Session]] */
    session?: Session;

    /** [[Account]] associated with current session */
    account?: Account;

    /** [[Auth]] associated with current session */
    auth?: Auth;

    /** Information about the device the request is coming from */
    device?: DeviceInfo;
}

export interface LegacyServer {
    getStore(email: string): Promise<PBES2Container | null>;
    deleteAccount(email: string): Promise<void>;
}

/**
 * Controller class for processing api requests
 */
export class Controller extends API {
    constructor(public server: Server, public context: Context) {
        super();
    }

    get config() {
        return this.server.config;
    }

    get storage() {
        return this.server.storage;
    }

    get messenger() {
        return this.server.messenger;
    }

    get logger() {
        return this.server.logger;
    }

    get attachmentStorage() {
        return this.server.attachmentStorage;
    }

    get legacyServer() {
        return this.server.legacyServer;
    }

    get authServers() {
        return this.server.authServers;
    }

    get provisioner() {
        return this.server.provisioner;
    }

    async authenticate(req: Request, ctx: Context) {
        if (!req.auth) {
            return;
        }

        let session: Session;

        // Find the session with the id specified in the [[Request.auth]] property
        try {
            session = await this.storage.get(Session, req.auth.session);
        } catch (e) {
            if (e.code === ErrorCode.NOT_FOUND) {
                throw new Err(ErrorCode.INVALID_SESSION);
            } else {
                throw e;
            }
        }

        // Reject expired sessions
        if (session.expires && session.expires < new Date()) {
            throw new Err(ErrorCode.SESSION_EXPIRED);
        }

        // Verify request signature
        if (!(await session.verify(req))) {
            throw new Err(ErrorCode.INVALID_REQUEST, "Failed to verify request signature!");
        }

        // Reject requests/responses older than a certain age to mitigate replay attacks
        const age = Date.now() - new Date(req.auth.time).getTime();
        if (age > this.config.maxRequestAge) {
            throw new Err(
                ErrorCode.MAX_REQUEST_AGE_EXCEEDED,
                "The request was rejected because it's timestamp is too far in the past. " +
                    "Please make sure your local clock is set to the correct time and try again!"
            );
        }

        // Get account associated with this session
        const account = await this.storage.get(Account, session.account);
        const auth = await this._getAuth(account.email);

        // Store account and session on context
        ctx.session = session;
        ctx.account = account;
        ctx.auth = auth;

        // Update session info
        session.lastUsed = new Date();
        session.device = ctx.device;
        session.lastLocation = req.location;
        session.updated = new Date();

        const i = auth.sessions.findIndex(({ id }) => id === session.id);
        if (i !== -1) {
            auth.sessions[i] = session.info;
        } else {
            auth.sessions.push(session.info);
        }

        await Promise.all([this.storage.save(session), this.storage.save(account), this.storage.save(auth)]);
    }

    async process(req: Request) {
        const def = this.handlerDefinitions.find((def) => def.method === req.method);

        if (!def) {
            throw new Err(ErrorCode.INVALID_REQUEST);
        }

        const clientVersion = (req.device && req.device.appVersion) || undefined;

        const param = req.params && req.params[0];

        const input = def.input && param ? new def.input().fromRaw(param) : param;

        const result = await this[def.method](input);

        const toRaw = (obj: any) => (obj instanceof Serializable ? obj.toRaw(clientVersion) : obj);

        return Array.isArray(result) ? result.map(toRaw) : toRaw(result);
    }

    async log(type: string, data: any = {}) {
        const acc = this.context.account;
        this.logger.log(type, {
            account: acc && { email: acc.email, id: acc.id, name: acc.name },
            device: this.context.device && this.context.device.toRaw(),
            ...data,
        });
    }

    /**
     * @deprecated
     */
    async requestMFACode({ email, purpose, type }: RequestMFACodeParams) {
        await this.startAuthRequest(new StartAuthRequestParams({ email, purpose, type: AuthType.Email }));
        this.log("mfa.requestCode", { email, purpose, type });
    }

    /**
     * @deprecated
     */
    async retrieveMFAToken({ email, code, purpose }: RetrieveMFATokenParams) {
        try {
            const auth = await this._getAuth(email);

            const request = auth.authRequests.find(
                (m) =>
                    m.type === AuthType.Email &&
                    m.purpose === purpose &&
                    m.state.email === email &&
                    m.state.verificationCode === code
            );
            if (!request) {
                throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to complete auth request.");
            }

            const authenticator = auth.authenticators.find((m) => m.id === request.authenticatorId);
            if (!authenticator) {
                throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to complete auth request.");
            }

            if (request.type !== authenticator.type) {
                throw new Err(
                    ErrorCode.AUTHENTICATION_FAILED,
                    "The auth request type and authenticator type do not match!"
                );
            }

            const provider = this._getAuthServer(request.type);

            try {
                await provider.verifyAuthRequest(authenticator, request, { code });
                request.status = AuthRequestStatus.Verified;
                request.verified = new Date();
                authenticator.lastUsed = new Date();
                await this.storage.save(auth);
            } catch (e) {
                request.tries++;
                await this.storage.save(auth);
                throw e;
            }

            const hasAccount = auth.accountStatus === AccountStatus.Active;

            const hasLegacyAccount = !!this.legacyServer && !!(await this.legacyServer.getStore(email));

            // If the user doesn't have an account but does have a legacy account,
            // repurpose the verification token for signup
            if (!hasAccount && hasLegacyAccount) {
                request.purpose = AuthPurpose.Signup;
            }

            let legacyToken: string | undefined = undefined;
            if (hasLegacyAccount) {
                const getLegacyDataMFARequest = new AuthRequest({
                    type: AuthType.Email,
                    purpose: AuthPurpose.GetLegacyData,
                });
                await getLegacyDataMFARequest.init();
                getLegacyDataMFARequest.verified = new Date();
                getLegacyDataMFARequest.status = AuthRequestStatus.Verified;
                legacyToken = getLegacyDataMFARequest.token;
                auth.authRequests.push(getLegacyDataMFARequest);
            }

            await this.storage.save(auth);

            this.log("mfa.retrieveToken", { email, success: true, hasAccount, hasLegacyAccount });

            return new RetrieveMFATokenResponse({
                token: request.token,
                hasAccount,
                hasLegacyAccount,
                legacyToken,
            });
        } catch (e) {
            this.log("mfa.retrieveToken", { email, success: false });
            throw e;
        }
    }

    async startRegisterAuthenticator({ type, purposes, data, device }: StartRegisterAuthenticatorParams) {
        const { auth } = this._requireAuth();
        const authenticator = new Authenticator({ type, purposes, device });
        await authenticator.init();
        const provider = this._getAuthServer(type);
        const responseData = await provider.initAuthenticator(authenticator, auth, data);
        auth.authenticators.push(authenticator);
        await this.storage.save(auth);
        return new StartRegisterAuthenticatorResponse({
            id: authenticator.id,
            data: responseData,
            type,
        });
    }

    async completeRegisterAuthenticator({ id, data }: CompleteRegisterMFAuthenticatorParams) {
        const { auth } = this._requireAuth();
        const method = auth.authenticators.find((m) => m.id === id);
        if (!method) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to complete mfa method registration.");
        }
        const provider = this._getAuthServer(method.type);
        const responseData = await provider.activateAuthenticator(method, data);
        method.status = AuthenticatorStatus.Active;
        await this.storage.save(auth);
        return new CompleteRegisterMFAuthenticatorResponse({ id: method.id, data: responseData });
    }

    async deleteAuthenticator(id: string) {
        const { auth } = this._requireAuth();
        if (auth.authenticators.length <= 1) {
            throw new Err(
                ErrorCode.BAD_REQUEST,
                "Cannot delete multi-factor authenticator. At least one authenticator is required."
            );
        }
        const index = auth.authenticators.findIndex((a) => a.id === id);
        if (index < 0) {
            throw new Err(ErrorCode.NOT_FOUND, "An authenticator with this ID does not exist!");
        }
        auth.authenticators.splice(index, 1);
        await this.storage.save(auth);
    }

    async startAuthRequest({
        email,
        authenticatorId,
        authenticatorIndex,
        type,
        supportedTypes,
        purpose,
        data,
    }: StartAuthRequestParams): Promise<StartAuthRequestResponse> {
        const auth = await this._getAuth(email);

        const authenticators = await this._getAuthenticators(auth);

        const availableAuthenticators = authenticators
            .filter(
                (m) =>
                    (typeof authenticatorId === "undefined" || m.id === authenticatorId) &&
                    (typeof type === "undefined" || m.type === type) &&
                    (typeof supportedTypes === "undefined" || supportedTypes.includes(m.type)) &&
                    (purpose === AuthPurpose.TestAuthenticator || m.purposes.includes(purpose)) &&
                    m.status === AuthenticatorStatus.Active
            )
            .sort((a, b) => auth.mfaOrder.indexOf(a.id) - auth.mfaOrder.indexOf(b.id));

        const authenticator = availableAuthenticators[authenticatorIndex || 0];
        if (!authenticator) {
            throw new Err(ErrorCode.NOT_FOUND, "No approriate authenticator found!");
        }

        const provider = this._getAuthServer(authenticator.type);
        const request = new AuthRequest({
            authenticatorId: authenticator.id,
            type: authenticator.type,
            purpose:
                purpose === AuthPurpose.Login && auth.accountStatus !== AccountStatus.Active
                    ? AuthPurpose.Signup
                    : purpose,
            device: this.context.device,
        });
        await request.init();

        const responseData = await provider.initAuthRequest(authenticator, request, data);
        auth.authRequests.push(request);

        authenticator.lastUsed = new Date();

        const deviceTrusted =
            this.context.device && auth.trustedDevices.some(({ id }) => id === this.context.device!.id);

        const response = new StartAuthRequestResponse({
            id: request.id,
            data: responseData,
            token: request.token,
            type: request.type,
            authenticatorId: authenticator.id,
            requestStatus: request.status,
            deviceTrusted,
        });

        if (request.purpose === AuthPurpose.Login && deviceTrusted) {
            request.verified = new Date();
            response.requestStatus = request.status = AuthRequestStatus.Verified;
            response.accountStatus = auth.accountStatus;
            response.provisioning = (await this.provisioner.getProvisioning(auth)).account;
        }

        await this.storage.save(auth);

        return response;
    }

    async completeAuthRequest({ email, id, data }: CompleteAuthRequestParams) {
        const auth = await this._getAuth(email);

        const request = auth.authRequests.find((m) => m.id === id);
        if (!request) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to complete auth request.");
        }

        const authenticators = await this._getAuthenticators(auth);

        const authenticator = authenticators.find((m) => m.id === request.authenticatorId);
        if (!authenticator) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to start auth request.");
        }

        if (request.type !== authenticator.type) {
            throw new Err(
                ErrorCode.AUTHENTICATION_FAILED,
                "The auth request type and authenticator type do not match!"
            );
        }

        const provider = this._getAuthServer(request.type);

        try {
            await provider.verifyAuthRequest(authenticator, request, data);

            request.status = AuthRequestStatus.Verified;
            request.verified = new Date();
            if (request.purpose === AuthPurpose.TestAuthenticator) {
                // We're merely testing the authenticator, so we can get rid of the
                // mfa token right away.
                await this.storage.save(auth);
                await this._useAuthToken({
                    email,
                    requestId: request.id,
                    ...request,
                });
            } else {
                authenticator.lastUsed = new Date();
                await this.storage.save(auth);
            }
        } catch (e) {
            request.tries++;
            await this.storage.save(auth);
            throw e;
        }

        await this.storage.save(auth);

        const deviceTrusted =
            auth && this.context.device && auth.trustedDevices.some(({ id }) => id === this.context.device!.id);
        const provisioning = (await this.provisioner.getProvisioning(auth)).account;

        return new CompleteAuthRequestResponse({
            accountStatus: auth.accountStatus,
            deviceTrusted,
            provisioning,
        });
    }

    async updateAuth({ verifier, keyParams, mfaOrder }: UpdateAuthParams): Promise<void> {
        const { auth } = this._requireAuth();

        if (verifier) {
            auth.verifier = verifier;
        }

        if (keyParams) {
            auth.keyParams = keyParams;
        }

        if (mfaOrder) {
            auth.mfaOrder = mfaOrder;
        }

        await this.storage.save(auth);

        this.log("auth.update");
    }

    async removeTrustedDevice(id: string): Promise<void> {
        const { auth } = this._requireAuth();
        const index = auth.trustedDevices.findIndex((d) => d.id === id);
        if (index < 0) {
            throw new Err(ErrorCode.NOT_FOUND, "No trusted device with this ID was found!");
        }
        auth.trustedDevices.splice(index, 1);
        await this.storage.save(auth);
    }

    async initAuth({ email, verify }: InitAuthParams): Promise<InitAuthResponse> {
        const auth = await this._getAuth(email);

        this.logger.log("auth.init", { email, account: auth && { email, id: auth.account } });

        const deviceTrusted =
            auth && this.context.device && auth.trustedDevices.some(({ id }) => id === this.context.device!.id);

        if (!deviceTrusted) {
            if (!verify) {
                throw new Err(ErrorCode.AUTHENTICATION_REQUIRED);
            } else {
                await this._useAuthToken({ email, token: verify, purpose: AuthPurpose.Login });
            }
        }

        if (!auth.account) {
            // The user has successfully verified their email address so it's safe to
            // tell them that this account doesn't exist.
            throw new Err(ErrorCode.NOT_FOUND, "An account with this email does not exist!");
        }

        const srpState = new SRPSession();
        await srpState.init();

        // Initiate SRP key exchange using the accounts verifier. This also
        // generates the random `B` value which will be passed back to the
        // client.
        const srp = new SRPServer(srpState);
        await srp.initialize(auth.verifier!);

        auth.srpSessions.push(srpState);

        await this.storage.save(auth);

        return new InitAuthResponse({
            account: auth.account,
            keyParams: auth.keyParams,
            B: srp.B!,
            srpId: srpState.id,
        });
    }

    async createSession({ account, srpId, A, M, addTrustedDevice }: CreateSessionParams): Promise<Session> {
        // Fetch the account in question
        const acc = await this.storage.get(Account, account);
        const auth = await this._getAuth(acc.email);

        // Get the pending SRP context for the given account
        const srpState = auth.srpSessions.find((s) => s.id === srpId);

        if (!srpState) {
            this.log("login", { account: { id: account }, success: false });
            throw new Err(ErrorCode.INVALID_CREDENTIALS);
        }

        const srp = new SRPServer(srpState);

        // Apply `A` received from the client to the SRP context. This will
        // compute the common session key and verification value.
        await srp.setA(A);

        // Verify `M`, which is the clients way of proving that they know the
        // accounts master password. This also guarantees that the session key
        // computed by the client and server are identical an can be used for
        // authentication.
        if (!equalCT(M, srp.M1!)) {
            this.log("login", { account: { id: account }, success: false });
            throw new Err(ErrorCode.INVALID_CREDENTIALS);
        }

        // Create a new session object
        const session = new Session();
        session.id = await uuid();
        session.created = new Date();
        session.account = account;
        session.device = this.context.device;
        session.key = srp.K!;

        // Add the session to the list of active sessions
        auth.sessions.push(session.info);

        // Delete pending SRP context
        auth.srpSessions = auth.srpSessions.filter((s) => s.id !== srpState.id);

        // Persist changes
        await Promise.all([this.storage.save(session), this.storage.save(acc)]);

        // Add device to trusted devices
        if (
            this.context.device &&
            !auth.trustedDevices.some(({ id }) => equalCT(id, this.context.device!.id)) &&
            addTrustedDevice
        ) {
            auth.trustedDevices.push(this.context.device);
        }
        await this.storage.save(auth);

        // Although the session key is secret in the sense that it should never
        // be transmitted between client and server, it still needs to be
        // stored on both sides, which is why it is included in the [[Session]]
        // classes serialization. So we have to make sure to remove the key
        // explicitly before returning.
        delete session.key;

        this.log("login", { account: { email: acc.email, id: acc.id }, success: true });

        return session;
    }

    async revokeSession(id: SessionID) {
        const { account, auth } = this._requireAuth();

        const session = await this.storage.get(Session, id);

        if (session.account !== account.id) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        const i = auth.sessions.findIndex((s) => s.id === id);
        auth.sessions.splice(i, 1);

        await Promise.all([this.storage.delete(session), this.storage.save(auth)]);

        this.log("logout");
    }

    async createAccount({
        account,
        auth: { verifier, keyParams },
        verify: authToken,
    }: CreateAccountParams): Promise<Account> {
        if (this.config.verifyEmailOnSignup) {
            await this._useAuthToken({ email: account.email, token: authToken, purpose: AuthPurpose.Signup });
        }

        const auth = await this._getAuth(account.email);

        // Make sure that no account with this email exists and that the email is not blocked from singing up
        if (auth.account) {
            throw new Err(ErrorCode.ACCOUNT_EXISTS, "This account already exists!");
        }

        // Most of the account object is constructed locally but account id and
        // revision are exclusively managed by the server
        account.id = await uuid();
        account.revision = await uuid();
        auth.account = account.id;
        auth.verifier = verifier;
        auth.keyParams = keyParams;
        auth.accountStatus = AccountStatus.Active;

        // Add device to trusted devices
        if (this.context.device && !auth.trustedDevices.some(({ id }) => id === this.context.device!.id)) {
            auth.trustedDevices.push(this.context.device);
        }

        // Provision the private vault for this account
        const vault = new Vault();
        vault.id = await uuid();
        vault.name = "My Vault";
        vault.owner = account.id;
        vault.created = new Date();
        vault.updated = new Date();
        account.mainVault = { id: vault.id };

        // Persist data
        await Promise.all([this.storage.save(account), this.storage.save(vault), this.storage.save(auth)]);

        account = await this.storage.get(Account, account.id);

        this.log("account.create", { account: { email: account.email, id: account.id, name: account.name } });

        return account;
    }

    async getAccount() {
        const { account } = this._requireAuth();
        this.log("account.get");

        return account;
    }

    async getAuthInfo() {
        const { auth } = this._requireAuth();
        const provisioning = await this.provisioner.getProvisioning(auth);
        return new AuthInfo({
            trustedDevices: auth.trustedDevices,
            authenticators: auth.authenticators,
            mfaOrder: auth.mfaOrder,
            sessions: auth.sessions,
            keyStoreEntries: auth.keyStoreEntries,
            invites: auth.invites,
            provisioning,
        });
    }

    async updateAccount({ name, email, publicKey, keyParams, encryptionParams, encryptedData, revision }: Account) {
        const { account } = this._requireAuth();

        // Check the revision id to make sure the changes are based on the most
        // recent version stored on the server. This is to ensure continuity in
        // case two clients try to make changes to an account at the same time.
        if (revision !== account.revision) {
            throw new Err(ErrorCode.OUTDATED_REVISION);
        }

        // Update revision id
        account.revision = await uuid();

        const nameChanged = account.name !== name;

        // Update account object
        Object.assign(account, { name, email, publicKey, keyParams, encryptionParams, encryptedData });

        // Persist changes
        account.updated = new Date();
        await this.storage.save(account);

        // If the accounts name has changed, well need to update the
        // corresponding member object on all organizations this account is a
        // member of.
        if (nameChanged) {
            for (const { id } of account.orgs) {
                const org = await this.storage.get(Org, id);
                org.getMember(account)!.name = name;
                await this.updateMetaData(org);
                await this.storage.save(org);
            }
        }

        this.log("account.update");

        return account;
    }

    async recoverAccount({
        account: { email, publicKey, keyParams, encryptionParams, encryptedData },
        auth: { keyParams: authKeyParams, verifier },
        verify,
    }: RecoverAccountParams) {
        // Check the email verification token
        await this._useAuthToken({ email, token: verify, purpose: AuthPurpose.Recover });

        // Find the existing auth information for this email address
        const auth = await this._getAuth(email);

        if (!auth.account) {
            throw new Err(ErrorCode.NOT_FOUND, "There is no account with this email address!");
        }

        // Fetch existing account
        const account = await this.storage.get(Account, auth.account);

        // Update account object
        Object.assign(account, { email, publicKey, keyParams, encryptionParams, encryptedData });

        Object.assign(auth, {
            keyParams: authKeyParams,
            verifier,
            trustedDevices: [],
            mfAuthenticators: [],
            mfaRequests: [],
        });

        // Create a new private vault, discarding the old one
        const mainVault = new Vault();
        mainVault.id = account.mainVault.id;
        mainVault.name = "My Vault";
        mainVault.owner = account.id;
        mainVault.created = new Date();
        mainVault.updated = new Date();

        // The new auth object has all the information except the account id
        this.context.device && auth.trustedDevices.push(this.context.device);

        // Revoke all sessions
        auth.sessions.forEach((s) => this.storage.delete(Object.assign(new Session(), s)));

        // Suspend memberships for all orgs that the account is not the owner of.
        // Since the accounts public key has changed, they will need to go through
        // the invite flow again to confirm their membership.
        for (const { id } of account.orgs) {
            const org = await this.storage.get(Org, id);
            if (!org.isOwner(account)) {
                const member = org.getMember(account)!;
                member.role = OrgRole.Suspended;
                await this.storage.save(org);
            }
        }

        // Persist changes
        await Promise.all([this.storage.save(account), this.storage.save(auth), this.storage.save(mainVault)]);

        this.log("account.recover", { account: { email: account.email, id: account.id, name: account.name } });

        return account;
    }

    async deleteAccount() {
        const { account, auth } = this._requireAuth();

        // Make sure that the account is not owner of any organizations
        const orgs = await Promise.all(account.orgs.map(({ id }) => this.storage.get(Org, id)));
        if (orgs.some((org) => org.isOwner(account))) {
            throw new Err(
                ErrorCode.BAD_REQUEST,
                "This account is the owner of one or more organizations and cannot " +
                    "be deleted. Please delete all your owned organizations first!"
            );
        }

        for (const org of orgs) {
            org.removeMember(account);
            await this.storage.save(org);
        }

        await this.provisioner.accountDeleted(auth);

        // Delete main vault
        await this.storage.delete(Object.assign(new Vault(), { id: account.mainVault }));

        // Revoke all sessions
        await auth.sessions.map((s) => this.storage.delete(Object.assign(new Session(), s)));

        // Delete auth object
        await this.storage.delete(auth);

        // Delete account object
        await this.storage.delete(account);

        this.log("account.delete");
    }

    async createOrg(org: Org) {
        const { account } = this._requireAuth();

        if (!org.name) {
            throw new Err(ErrorCode.BAD_REQUEST, "Please provide an organization name!");
        }

        const existingOrgs = await Promise.all(account.orgs.map(({ id }) => this.storage.get(Org, id)));
        const ownedOrgs = existingOrgs.filter((o) => o.owner === account.id);

        const provisioning = await this.provisioner.getProvisioning({
            email: account.email,
            accountId: account.id,
        });

        if (provisioning.account.status !== ProvisioningStatus.Active) {
            throw new Err(
                ErrorCode.PROVISIONING_NOT_ALLOWED,
                "You're not allowed to create an organization right now."
            );
        }

        if (provisioning.account.quota.orgs !== -1 && ownedOrgs.length >= provisioning.account.quota.orgs) {
            throw new Err(
                ErrorCode.PROVISIONING_QUOTA_EXCEEDED,
                "You have reached the maximum number of organizations for this account!"
            );
        }

        org.id = await uuid();
        org.revision = await uuid();
        org.owner = account.id;
        org.created = new Date();
        org.updated = new Date();

        await this.storage.save(org);

        account.orgs.push({ id: org.id, name: org.name });
        await this.storage.save(account);

        this.log("org.create", { org: { name: org.name, id: org.id, type: org.type } });

        return org;
    }

    async getOrg(id: OrgID) {
        const { account } = this._requireAuth();

        const org = await this.storage.get(Org, id);

        // Only members can read organization data. For non-members,
        // we pretend the organization doesn't exist.
        if (org.owner !== account.id && !org.isMember(account)) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        this.log("org.get", { org: { name: org.name, id: org.id, type: org.type } });

        return org;
    }

    async updateOrg({
        id,
        name,
        publicKey,
        keyParams,
        encryptionParams,
        encryptedData,
        signingParams,
        accessors,
        members,
        groups,
        vaults,
        invites,
        revision,
        minMemberUpdated,
    }: Org) {
        const { account, auth } = this._requireAuth();

        // Get existing org based on the id
        const org = await this.storage.get(Org, id);

        const provisitioning = await this.provisioner.getProvisioning(auth);
        const orgProvisioning = provisitioning.orgs.find((o) => o.orgId === id);

        if (!orgProvisioning) {
            throw new Err(ErrorCode.PROVISIONING_NOT_ALLOWED, "Could not find provisioning for this organization!");
        }

        if (orgProvisioning.status === ProvisioningStatus.Frozen) {
            throw new Err(
                ErrorCode.PROVISIONING_NOT_ALLOWED,
                'You can not make any updates to an organization while it is in "frozen" state!'
            );
        }

        // Check the revision id to make sure the changes are based on the most
        // recent version stored on the server. This is to ensure continuity in
        // case two clients try to make changes to an organization at the same
        // time.
        if (revision !== org.revision) {
            throw new Err(ErrorCode.OUTDATED_REVISION);
        }

        const isOwner = org.owner === account.id || org.isOwner(account);
        const isAdmin = isOwner || org.isAdmin(account);

        // Only admins can make any changes to organizations at all.
        if (!isAdmin) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS, "Only admins can make changes to organizations!");
        }

        // Verify that `minMemberUpdated` is equal to or larger than the previous value
        if (minMemberUpdated < org.minMemberUpdated) {
            throw new Err(
                ErrorCode.BAD_REQUEST,
                "`minMemberUpdated` property needs to be equal to or larger than the previous one!"
            );
        }

        const addedMembers = members.filter((m) => !org.isMember(m));
        const removedMembers = org.members.filter(({ id }) => !members.some((m) => id === m.id));
        const addedInvites = invites.filter(({ id }) => !org.getInvite(id));
        const removedInvites = org.invites.filter(({ id }) => !invites.some((inv) => id === inv.id));

        // Only org owners can add or remove members, change roles or create invites
        if (
            !isOwner &&
            (addedMembers.length ||
                removedMembers.length ||
                addedInvites.length ||
                removedInvites.length ||
                members.some(({ id, role }) => {
                    const member = org.getMember({ id });
                    return !member || member.role !== role;
                }))
        ) {
            throw new Err(
                ErrorCode.INSUFFICIENT_PERMISSIONS,
                "Only organization owners can add or remove members, change roles or create invites!"
            );
        }

        // Check members quota
        if (orgProvisioning.quota.members !== -1 && members.length > orgProvisioning.quota.members) {
            throw new Err(
                ErrorCode.PROVISIONING_QUOTA_EXCEEDED,
                "You have reached the maximum number of members for this organization!"
            );
        }

        // Check groups quota
        if (orgProvisioning.quota.groups !== -1 && groups.length > orgProvisioning.quota.groups) {
            throw new Err(
                ErrorCode.PROVISIONING_QUOTA_EXCEEDED,
                "You have reached the maximum number of groups for this organization!"
            );
        }

        Object.assign(org, {
            members,
            groups,
            vaults,
        });

        // certain properties may only be updated by organization owners
        if (isOwner) {
            Object.assign(org, {
                name,
                publicKey,
                keyParams,
                encryptionParams,
                encryptedData,
                signingParams,
                accessors,
                invites,
                minMemberUpdated,
            });
        }

        const promises: Promise<void>[] = [];

        // New invites
        for (const invite of addedInvites) {
            promises.push(
                (async () => {
                    let path = `invite/${org.id}/${invite.id}`;
                    let params = new URLSearchParams();
                    params.set("email", invite.email);

                    const auth = await this._getAuth(invite.email);
                    auth.invites.push({ id: invite.id, orgId: org.id, orgName: org.name });

                    // If account does not exist yet, create a email verification code
                    // and send it along with the url so they can skip that step
                    if (auth.accountStatus === AccountStatus.Unregistered) {
                        // account does not exist yet; add verification code to link
                        const signupRequest = new AuthRequest({
                            type: AuthType.Email,
                            purpose: AuthPurpose.Signup,
                        });
                        await signupRequest.init();
                        signupRequest.verified = new Date();
                        signupRequest.status = AuthRequestStatus.Verified;
                        auth.authRequests.push(signupRequest);
                        params.set("next", path);
                        params.set("mfaToken", signupRequest.token);
                        params.set("mfaId", signupRequest.id);
                        params.set("mfaVerified", "true");
                        path = "signup/";
                    }

                    await this.storage.save(auth);

                    // Send invite link to invitees email address
                    this.messenger.send(
                        invite.email,
                        new InviteCreatedMessage(invite, `${this.config.clientUrl}/${path}?${params.toString()}`)
                    );
                })()
            );
        }

        for (const invite of removedInvites) {
            promises.push(
                (async () => {
                    const auth = await this._getAuth(invite.email);
                    auth.invites = auth.invites.filter((inv) => inv.id !== invite.id);
                    await this.storage.save(auth);
                })()
            );
        }

        // Removed members
        for (const { id } of removedMembers) {
            promises.push(
                (async () => {
                    const acc = await this.storage.get(Account, id);
                    acc.orgs = acc.orgs.filter((o) => o.id !== org.id);
                    await this.storage.save(acc);
                })()
            );
        }

        await this.updateMetaData(org);

        // Send a notification email to let the new member know they've been added
        for (const member of addedMembers) {
            if (member.id !== account.id) {
                this.messenger.send(
                    member.email,
                    new MemberAddedMessage(org, `${this.config.clientUrl}/org/${org.id}`)
                );
            }
        }

        await Promise.all(promises);

        await this.storage.save(org);

        this.log("org.update", { org: { name: org.name, id: org.id, type: org.type } });

        return org;
    }

    async deleteOrg(id: OrgID) {
        const { account } = this._requireAuth();

        const org = await this.storage.get(Org, id);

        if (!org.isOwner(account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Delete all associated vaults
        await Promise.all(org.vaults.map((v) => this.storage.delete(Object.assign(new Vault(), v))));

        // Remove org from all member accounts
        await Promise.all(
            org.members.map(async (member) => {
                const acc = await this.storage.get(Account, member.id);
                acc.orgs = acc.orgs.filter(({ id }) => id !== org.id);
                await this.storage.save(acc);
            })
        );

        await this.storage.delete(org);

        this.log("org.delete", { org: { name: org.name, id: org.id, type: org.type } });
    }

    async getVault(id: VaultID) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, id);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        if (org && org.isSuspended(account)) {
            throw new Err(
                ErrorCode.INSUFFICIENT_PERMISSIONS,
                "This vault cannot be synchronized because you're suspended from it's organization."
            );
        }

        // Accounts can only read their private vaults and vaults they have been assigned to
        // on an organization level. For everyone else, pretend like the vault doesn't exist.
        if ((org && !org.canRead(vault, account)) || (!org && vault.owner !== account.id)) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        this.log("vault.get", {
            vault: { id: vault.id, name: vault.name },
            org: org && { id: org.id, name: org.name, type: org.type },
        });

        return vault;
    }

    async updateVault({ id, keyParams, encryptionParams, accessors, encryptedData, revision }: Vault) {
        const { account, auth } = this._requireAuth();

        const vault = await this.storage.get(Vault, id);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));
        const provisioning = await this.provisioner.getProvisioning(auth);
        const orgProvisioning = org && provisioning.orgs.find((o) => o.orgId === org.id);

        const prov = orgProvisioning || provisioning.account;

        if (!prov) {
            throw new Err(ErrorCode.PROVISIONING_NOT_ALLOWED, "No provisioning found for this vault!");
        }

        if (org && org.isSuspended(account)) {
            throw new Err(
                ErrorCode.INSUFFICIENT_PERMISSIONS,
                "This vault cannot be synchronized because you're suspended from it's organization."
            );
        }

        // Accounts can only read their private vaults and vaults they have been assigned to
        // on an organization level. For everyone else, pretend like the vault doesn't exist.
        if ((org && !org.canRead(vault, account)) || (!org && vault.owner !== account.id)) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        // Vaults can only be updated by accounts that have explicit write access
        if (org && !org.canWrite(vault, account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        if (prov.status === ProvisioningStatus.Frozen) {
            throw new Err(
                ErrorCode.PROVISIONING_NOT_ALLOWED,
                org
                    ? 'You can not make any updates to a vault while it\'s organization is in "frozen" state!'
                    : 'You can\'t make any updates to your vault while your account is in "frozen" state!'
            );
        }

        // Check the revision id to make sure the changes are based on the most
        // recent version stored on the server. This is to ensure continuity in
        // case two clients try to make changes to an organization at the same
        // time.
        if (revision !== vault.revision) {
            throw new Err(ErrorCode.OUTDATED_REVISION);
        }

        // Update vault properties
        Object.assign(vault, { keyParams, encryptionParams, accessors, encryptedData });

        // update revision
        vault.revision = await uuid();
        vault.updated = new Date();

        // Persist changes
        await this.storage.save(vault);

        if (org) {
            // Update Org revision (since vault info has changed)
            await this.updateMetaData(org);
            await this.storage.save(org);
        } else {
            // Update main vault revision info on account
            account.mainVault.revision = vault.revision;
            await this.storage.save(account);
        }

        this.log("vault.update", {
            vault: { id: vault.id, name: vault.name },
            org: org && { id: org.id, name: org.name, type: org.type },
        });

        return this.storage.get(Vault, vault.id);
    }

    async createVault(vault: Vault) {
        const { account, auth } = this._requireAuth();

        // Explicitly creating vaults only works in the context of an
        // organization (private vaults are created automatically)
        if (!vault.org) {
            throw new Err(ErrorCode.BAD_REQUEST, "Shared vaults have to be attached to an organization.");
        }

        const org = await this.storage.get(Org, vault.org.id);
        const provisioning = await this.provisioner.getProvisioning(auth);
        const orgProvisioning = org && provisioning.orgs.find((o) => o.orgId === org.id);

        if (!orgProvisioning) {
            throw new Err(ErrorCode.PROVISIONING_NOT_ALLOWED, "No provisioning found for this vault!");
        }

        // Only admins can create new vaults for an organization
        if (!org.isAdmin(account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Create vault object
        vault.id = await uuid();
        vault.owner = account.id;
        vault.created = vault.updated = new Date();
        vault.revision = await uuid();

        // Add to organization
        org.vaults.push({ id: vault.id, name: vault.name });
        org.revision = await uuid();

        // Check vault quota of organization
        if (orgProvisioning.quota.vaults !== -1 && org.vaults.length > orgProvisioning.quota.vaults) {
            throw new Err(
                ErrorCode.PROVISIONING_QUOTA_EXCEEDED,
                "You have reached the maximum number of vaults for this organization!"
            );
        }

        // Persist cahnges
        await Promise.all([this.storage.save(vault), this.storage.save(org)]);

        this.log("vault.create", {
            vault: { id: vault.id, name: vault.name },
            org: org && { id: org.id, name: org.name, type: org.type },
        });

        return vault;
    }

    async deleteVault(id: VaultID) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, id);

        // Only vaults that have been created in the context of an
        // organization can be deleted (private vaults are managed
        // by the server implicitly)
        if (!vault.org) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        const org = await this.storage.get(Org, vault.org.id);

        // Only org admins can delete vaults
        if (!org.isAdmin(account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Delete all attachments associated with this vault
        await this.attachmentStorage.deleteAll(vault.id);

        // Remove vault from org
        org.vaults = org.vaults.filter((v) => v.id !== vault.id);

        // Remove any assignments to this vault from members and groups
        for (const each of [...org.getGroupsForVault(vault), ...org.getMembersForVault(vault)]) {
            each.vaults = each.vaults.filter((v) => v.id !== vault.id);
        }

        await this.updateMetaData(org);

        // Save org
        await this.storage.save(org);

        // Delete vault
        await this.storage.delete(vault);

        this.log("vault.delete", {
            vault: { id: vault.id, name: vault.name },
            org: org && { id: org.id, name: org.name, type: org.type },
        });
    }

    async getInvite({ org: orgId, id }: GetInviteParams) {
        const { account } = this._requireAuth();

        const org = await this.storage.get(Org, orgId);
        const invite = org.getInvite(id);

        if (
            !invite ||
            // User may only see invite if they are a vault owner or the invite recipient
            (!org.isOwner(account) && invite.email !== account.email)
        ) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        this.log("invite.get", {
            invite: { id: invite.id, email: invite.email },
            org: { id: org.id, name: org.name, type: org.type },
        });

        return invite;
    }

    async acceptInvite(invite: Invite) {
        // Passed invite object need to have *accepted* status
        if (!invite.accepted) {
            throw new Err(ErrorCode.BAD_REQUEST);
        }

        const { account } = this._requireAuth();

        // Get existing invite object
        const org = await this.storage.get(Org, invite.org.id);
        const existing = org.getInvite(invite.id);

        if (!existing) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        // Only the invite recipient can accept the invite
        if (existing.email !== account.email) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS, "Only the invite recipient can accept the invite.");
        }

        if (!existing.accepted && invite.invitedBy) {
            // Send message to the creator of the invite notifying them that
            // the recipient has accepted the invite
            this.messenger.send(
                invite.invitedBy.email,
                new InviteAcceptedMessage(invite, `${this.config.clientUrl}/invite/${org.id}/${invite.id}`)
            );
        }

        // Update invite object
        org.invites[org.invites.indexOf(existing)] = invite;

        await this.updateMetaData(org);

        // Persist changes
        await this.storage.save(org);

        this.log("invite.accept", {
            invite: { id: invite.id, email: invite.email },
            org: { id: org.id, name: org.name, type: org.type },
        });
    }

    async createAttachment(att: Attachment) {
        const { account, auth } = this._requireAuth();

        const vault = await this.storage.get(Vault, att.vault);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        const allowed = org ? org.canWrite(vault, account) : vault.owner === account.id;

        if (!allowed) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        att.id = await uuid();

        const currentUsage = await this.attachmentStorage.getUsage(vault.id);
        const provisioning = await this.provisioner.getProvisioning(auth);
        const vaultProvisioning = provisioning.vaults.find((v) => v.vaultId === vault.id);

        if (!vaultProvisioning) {
            throw new Err(ErrorCode.PROVISIONING_NOT_ALLOWED, "No provisioning found for this vault!");
        }

        if (vaultProvisioning.quota.storage !== -1 && currentUsage + att.size > vaultProvisioning.quota.storage * 1e6) {
            throw new Err(
                ErrorCode.PROVISIONING_QUOTA_EXCEEDED,
                "You have reached the file storage limit for this vault!"
            );
        }

        await this.attachmentStorage.put(att);

        this.log("attachment.create", {
            attachment: { type: att.type, size: att.size, id: att.id },
            vault: { id: vault.id, name: vault.name },
            org: org && { id: org!.id, name: org!.name, type: org!.type },
        });

        return att.id;
    }

    async getAttachment({ id, vault: vaultId }: GetAttachmentParams) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, vaultId);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        const allowed = org ? org.canRead(vault, account) : vault.owner === account.id;

        if (!allowed) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        const att = await this.attachmentStorage.get(vaultId, id);

        this.log("attachment.get", {
            attachment: { type: att.type, size: att.size, id: att.id },
            vault: { id: vault.id, name: vault.name },
            org: org && { id: org!.id, name: org!.name, type: org!.type },
        });

        return att;
    }

    async deleteAttachment({ vault: vaultId, id }: DeleteAttachmentParams) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, vaultId);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        const allowed = org ? org.canWrite(vault, account) : vault.owner === account.id;

        if (!allowed) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        await this.attachmentStorage.delete(vaultId, id);

        this.log("attachment.delete", {
            attachment: { id },
            vault: { id: vault.id, name: vault.name },
            org: org && { id: org!.id, name: org!.name, type: org!.type },
        });
    }

    async getLegacyData({ email, verify }: GetLegacyDataParams) {
        if (verify) {
            await this._useAuthToken({ email, token: verify, purpose: AuthPurpose.GetLegacyData });
        } else {
            const { account } = this._requireAuth();
            if (account.email !== email) {
                throw new Err(ErrorCode.BAD_REQUEST);
            }
        }

        if (!this.legacyServer) {
            throw new Err(ErrorCode.NOT_SUPPORTED, "This Padloc instance does not support this feature!");
        }

        const data = await this.legacyServer.getStore(email);

        if (!data) {
            throw new Err(ErrorCode.NOT_FOUND, "No legacy account found.");
        }

        return data;
    }

    async deleteLegacyAccount() {
        if (!this.legacyServer) {
            throw new Err(ErrorCode.NOT_SUPPORTED, "This Padloc instance does not support this feature!");
        }

        const { account } = this._requireAuth();

        await this.legacyServer.deleteAccount(account.email);
    }

    updateMetaData(org: Org) {
        return this.server.updateMetaData(org);
    }

    async createKeyStoreEntry({ data, authenticatorId }: CreateKeyStoreEntryParams) {
        const { account, auth } = this._requireAuth();
        if (
            !auth.authenticators.some(
                (a) => a.id === authenticatorId && a.purposes.includes(AuthPurpose.AccessKeyStore)
            )
        ) {
            throw new Err(ErrorCode.NOT_FOUND, "No suitable authenticator found!");
        }

        const entry = new KeyStoreEntry({ accountId: account.id, data, authenticatorId });
        await entry.init();

        await this.storage.save(entry);

        auth.keyStoreEntries.push(entry.info);

        await this.storage.save(auth);

        return entry;
    }

    async getKeyStoreEntry({ id, mfaToken }: GetKeyStoreEntryParams) {
        const { account } = this._requireAuth();
        const entry = await this.storage.get(KeyStoreEntry, id);

        await this._useAuthToken({
            email: account.email,
            token: mfaToken,
            purpose: AuthPurpose.AccessKeyStore,
            authenticatorId: entry.authenticatorId,
        });

        return entry;
    }

    async deleteKeyStoreEntry(id: string) {
        const { account, auth } = this._requireAuth();

        const entry = await this.storage.get(KeyStoreEntry, id);

        if (entry.accountId !== account.id) {
            throw new Err(
                ErrorCode.INSUFFICIENT_PERMISSIONS,
                "You don't have the necessary permissions to perform this action!"
            );
        }

        await this.storage.delete(entry);

        auth.keyStoreEntries = auth.keyStoreEntries.filter((e) => e.id !== entry.id);

        await this.storage.save(auth);
    }

    private _requireAuth(): { account: Account; session: Session; auth: Auth } {
        const { account, session, auth } = this.context;

        if (!session || !account || !auth) {
            throw new Err(ErrorCode.INVALID_SESSION);
        }

        return { account, session, auth };
    }

    private async _getAuthenticators(auth: Auth) {
        const purposes = [AuthPurpose.Signup, AuthPurpose.Login, AuthPurpose.Recover, AuthPurpose.GetLegacyData];

        const adHocAuthenticators = await Promise.all(
            this.config.defaultAuthTypes.map((type) => this._createAdHocAuthenticator(auth, purposes, type))
        );

        const authenticators = [...auth.authenticators, ...adHocAuthenticators];

        return authenticators;
    }

    private async _createAdHocAuthenticator(auth: Auth, purposes: AuthPurpose[], type: AuthType) {
        const authServer = this._getAuthServer(type);
        const authenticator = new Authenticator({
            type,
            status: AuthenticatorStatus.Active,
            purposes,
            id: `ad_hoc_${auth.email}_${type}`,
        });
        await authServer.initAuthenticator(authenticator, auth);
        return authenticator;
    }

    private async _getAuth(email: string) {
        let auth: Auth | null = null;

        try {
            auth = await this.storage.get(Auth, await getIdFromEmail(email));
        } catch (e) {
            if (e.code !== ErrorCode.NOT_FOUND) {
                throw e;
            }
        }

        if (!auth) {
            // In previous versions the accounts plain email address was used
            // as the key directly, check if one such entry exists and if so,
            // take it and migrate it to the new key format.
            try {
                auth = await this.storage.get(Auth, email);
                await auth.init();
                await this.storage.save(auth);
                await this.storage.delete(Object.assign(new Auth(), { id: auth.email }));
            } catch (e) {}
        }

        if (!auth) {
            auth = new Auth(email);
            await auth.init();
        }

        return auth;
    }

    private _getAuthServer(type: AuthType) {
        const provider = this.authServers.find((prov) => prov.supportsType(type));
        if (!provider) {
            throw new Err(
                ErrorCode.NOT_SUPPORTED,
                `This multi factor authentication type is not supported by this server!`
            );
        }
        return provider;
    }

    private async _useAuthToken({
        email,
        token,
        purpose,
        authenticatorId,
        requestId,
    }: {
        email: string;
        token: string;
        purpose: AuthPurpose;
        authenticatorId?: string;
        requestId?: string;
    }) {
        const auth = await this._getAuth(email);
        if (!auth) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to verify auth token");
        }

        const request = auth.authRequests.find(
            (r) =>
                (typeof authenticatorId === "undefined" || r.authenticatorId === authenticatorId) &&
                (typeof requestId === "undefined" || r.id === requestId) &&
                r.token === token &&
                r.status === AuthRequestStatus.Verified &&
                r.purpose === purpose
        );

        if (!request) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to verify auth token");
        }

        auth.authRequests = auth.authRequests.filter((r) => r.id !== request.id);

        await this.storage.save(auth);
    }
}

/**
 * The Padloc server acts as a central repository for [[Account]]s, [[Org]]s
 * and [[Vault]]s. [[Server]] handles authentication, enforces user privileges
 * and acts as a mediator for key exchange between clients.
 *
 * The server component acts on a strict zero-trust, zero-knowledge principle
 * when it comes to sensitive data, meaning no sensitive data is ever exposed
 * to the server at any point, nor should the server (or the person controlling
 * it) ever be able to temper with critical data or trick users into granting
 * them access to encrypted information.
 */
export class Server {
    constructor(
        public config: ServerConfig,
        public storage: Storage,
        public messenger: Messenger,
        /** Logger to use */
        public logger: Logger = new Logger(new VoidStorage()),
        public authServers: AuthServer[] = [],
        /** Attachment storage */
        public attachmentStorage: AttachmentStorage,
        public provisioner: Provisioner = new StubProvisioner(),
        public legacyServer?: LegacyServer
    ) {}

    private _requestQueue = new Map<AccountID | OrgID, Promise<void>>();

    makeController(ctx: Context) {
        return new Controller(this, ctx);
    }

    /** Handles an incoming [[Request]], processing it and constructing a [[Reponse]] */
    async handle(req: Request) {
        const res = new Response();
        const context: Context = {};
        try {
            context.device = req.device;
            try {
                await loadLanguage((context.device && context.device.locale) || "en");
            } catch (e) {}

            const controller = this.makeController(context);
            await controller.authenticate(req, context);

            const done = await this._addToQueue(context);

            try {
                res.result = (await controller.process(req)) || null;
            } finally {
                done();
            }

            if (context.session) {
                await context.session.authenticate(res);
            }
        } catch (e) {
            this._handleError(e, req, res, context);
        }
        return res;
    }

    async updateMetaData(org: Org) {
        org.revision = await uuid();
        org.updated = new Date();

        const promises: Promise<void>[] = [];

        const deletedVaults = new Set<VaultID>();
        const deletedMembers = new Set<AccountID>();

        // Updated related vaults
        for (const vaultInfo of org.vaults) {
            promises.push(
                (async () => {
                    try {
                        const vault = await this.storage.get(Vault, vaultInfo.id);
                        vault.name = vaultInfo.name;
                        vault.org = {
                            id: org.id,
                            name: org.name,
                            revision: org.revision,
                        };
                        await this.storage.save(vault);

                        vaultInfo.revision = vault.revision;
                    } catch (e) {
                        if (e.code !== ErrorCode.NOT_FOUND) {
                            throw e;
                        }

                        deletedVaults.add(vaultInfo.id);
                    }
                })()
            );
        }

        // Update org info on members
        for (const member of org.members) {
            promises.push(
                (async () => {
                    try {
                        const acc = await this.storage.get(Account, member.id);

                        acc.orgs = [
                            ...acc.orgs.filter((o) => o.id !== org.id),
                            { id: org.id, name: org.name, revision: org.revision },
                        ];

                        await this.storage.save(acc);

                        member.name = acc.name;
                    } catch (e) {
                        if (e.code !== ErrorCode.NOT_FOUND) {
                            throw e;
                        }

                        deletedMembers.add(member.id);
                    }
                })()
            );
        }

        await Promise.all(promises);

        org.vaults = org.vaults.filter((v) => !deletedVaults.has(v.id));
        org.members = org.members.filter((m) => !deletedMembers.has(m.id));
    }

    private async _addToQueue(context: Context) {
        if (!context.account) {
            return () => {};
        }

        const account = context.account;
        const resolveFuncs: (() => void)[] = [];
        const promises: Promise<void>[] = [];

        for (const { id } of [account, ...account.orgs]) {
            const promise = this._requestQueue.get(id);
            if (promise) {
                promises.push(promise);
            }
            this._requestQueue.set(id, new Promise((resolve) => resolveFuncs.push(resolve)));
        }

        await Promise.all(promises);

        return () => resolveFuncs.forEach((resolve) => resolve());
    }

    private _handleError(error: Error, req: Request, res: Response, context: Context) {
        console.error(error);

        const e =
            error instanceof Err
                ? error
                : new Err(
                      ErrorCode.SERVER_ERROR,
                      "Something went wrong while we were processing your request. " +
                          "Our team has been notified and will resolve the problem as soon as possible!",
                      { report: true, error }
                  );

        res.error = {
            code: e.code,
            message: e.message,
        };

        const evt = this.logger.log("error", {
            account: context.account && {
                id: context.account.id,
                email: context.account.email,
                name: context.account.name,
            },
            device: context.device && context.device.toRaw(),
            error: e.toRaw(),
            method: req.method,
            request: e.report ? req : undefined,
        });

        if (e.report && this.config.reportErrors) {
            this.messenger.send(this.config.reportErrors, {
                title: "Padloc Error Notification",
                text:
                    `The following error occurred at ${e.time}:\n\n` +
                    `Code: ${e.code}\n` +
                    `Message: ${e.message}\n` +
                    `Event ID: ${evt.id}`,
                html: "",
            });
        }
    }
}

package client

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"clickonetwo.io/whisper/server/middleware"
	"clickonetwo.io/whisper/server/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// HasAuthChanged determines whether the client requires new authorization data.
//
// See [RefreshSecret] for more about secret rotation.
func (data *Data) HasAuthChanged(c *gin.Context) (bool, string) {
	existing := &Data{Id: data.Id}
	if err := storage.LoadFields(c.Request.Context(), existing); err != nil {
		return true, "APNS token from new"
	}
	if existing.LastSecret != data.LastSecret {
		return true, "unconfirmed secret from existing"
	}
	if existing.Token != data.Token {
		return true, "new APNS token from existing"
	}
	if existing.AppInfo != data.AppInfo {
		return true, "new build data from existing"
	}
	if data.IsPresenceLogging == 0 {
		return true, "no presence logging from existing"
	}
	return false, ""
}

// RefreshSecret generates a new secret and pushes it to the client.
//
// Secrets rotate.  The client generates its first secret, and always
// sets that as both the current and prior secret.  After that, every
// time the server sends a new secret, the current secret rotates its secret
// to be the prior secret.  The client sends the prior secret with every launch,
// because this allows the server to know when the client has gone out of sync
// (for example, when a client moves from apns dev to apns prod),
// and the server rotates the secret when that happens.  Clients sign auth requests
// with the current secret, but the server allows use of the prior
// secret as a fallback when the client has gone out of sync.
func (data *Data) RefreshSecret(c *gin.Context, force bool) (bool, error) {
	if data.Token == "" {
		return false, fmt.Errorf("can't have a secret without a device token: %#v", data)
	}
	if force || data.Secret == "" || data.SecretDate == 0 {
		if data.Secret != "" && data.SecretDate == 0 {
			// a secret has been issued for this client, but it's never been received.
			// since these are often sent twice, it's important not to change it in case
			// there was simply a delay in responding to the notification.
			middleware.CtxLogS(c).Infow("Reusing sent-but-never-received secret", "client", data.Id)
		} else {
			middleware.CtxLogS(c).Infow("Issuing a new secret", "client", data.Id)
			data.Secret = MakeNonce()
			data.SecretDate = 0
		}
		data.PushId = uuid.New().String()
		if err := storage.SaveFields(c.Request.Context(), data); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

func MakeNonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("Could not generate nonce: %v", err))
	}
	return hex.EncodeToString(b)
}

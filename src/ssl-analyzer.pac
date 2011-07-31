# Analyzer for SSL (Bro-specific part).

%extern{
#include <vector>
#include <algorithm>
#include <iostream>
#include <iterator>

#include "util.h"

#include <openssl/x509.h>
#include <openssl/asn1.h>
%}


%header{
	class extract_certs {
	public:
		bytestring const& operator() (X509Certificate* cert) const
			{
			return cert->certificate();
			}
	};

	void free_X509(void *);
	X509* d2i_X509_binpac(X509** px, const uint8** in, int len);
	%}

%code{
	void free_X509(void* cert)
		{
		X509_free((X509*) cert);
		}

	X509* d2i_X509_binpac(X509** px, const uint8** in, int len)
		{
#ifdef OPENSSL_D2I_X509_USES_CONST_CHAR
		return d2i_X509(px, in, len);
#else
		return d2i_X509(px, (u_char**) in, len);
#endif
		}
%}


function to_string_val(data : uint8[]) : StringVal
	%{
	char tmp[32];
	memset(tmp, 0, sizeof(tmp));

	// Just return an empty string if the string is longer than 32 bytes
	if ( data && data->size() <= 32 )
		{
		for ( unsigned int i = data->size(); i > 0; --i )
			tmp[i-1] = (*data)[i-1];
		}

	return new StringVal(32, tmp);
	%}

function version_ok(vers : uint16) : bool
	%{
	switch ( vers ) {
	case SSLv20:
	case SSLv30:
	case TLSv10:
	case TLSv11:
		return true;

	default:
		return false;
	}
	%}

refine connection SSL_Conn += {

	%member{
	%}

	%init{
	%}

	%eof{
		if ( state_ != STATE_CONN_ESTABLISHED &&
		     state_ != STATE_TRACK_LOST &&
		     state_ != STATE_INITIAL )
			bro_analyzer()->ProtocolViolation(fmt("unexpected end of connection in state %s",
				state_label(state_).c_str()));
	%}

	%cleanup{
	%}

	function proc_change_cipher_spec(rec: SSLRecord) : bool
		%{
		if ( state_ == STATE_TRACK_LOST )
			bro_analyzer()->ProtocolViolation(fmt("unexpected ChangeCipherSpec from %s at state %s",
				orig_label(${rec.is_orig}).c_str(),
				state_label(old_state_).c_str()));
		return true;
		%}

	function proc_application_data(rec: SSLRecord) : bool
		%{
		if ( state_ != STATE_CONN_ESTABLISHED &&
		     (state_ != STATE_CLIENT_FINISHED && ! ${rec.is_orig}) )
			bro_analyzer()->ProtocolViolation(fmt("unexpected ApplicationData from %s at state %s",
				orig_label(${rec.is_orig}).c_str(),
				state_label(old_state_).c_str()));
		return true;
		%}

	function proc_alert(rec: SSLRecord, level : int, desc : int) : bool
		%{
		BifEvent::generate_ssl_alert(bro_analyzer(), bro_analyzer()->Conn(),
						level, desc);
		return true;
		%}

	function proc_client_hello(rec: SSLRecord,
					version : uint16, ts : double,
					session_id : uint8[],
					cipher_suites16 : uint16[], 
					cipher_suites24 : uint24[]) : bool
		%{
		if ( state_ == STATE_TRACK_LOST )
			bro_analyzer()->ProtocolViolation(fmt("unexpected client hello message from %s in state %s",
				orig_label(${rec.is_orig}).c_str(),
				state_label(old_state_).c_str()));

		if ( ! version_ok(version) )
			bro_analyzer()->ProtocolViolation(fmt("unsupported client SSL version 0x%04x", version));

		if ( ssl_client_hello )
			{
			vector<int>* cipher_suites = new vector<int>();
			if ( cipher_suites16  )
				std::copy(cipher_suites16->begin(), cipher_suites16->end(), std::back_inserter(*cipher_suites));
			else
				std::transform(cipher_suites24->begin(), cipher_suites24->end(), std::back_inserter(*cipher_suites), to_int());

			TableVal* cipher_set = new TableVal(internal_type("count_set")->AsTableType());
			for ( unsigned int i = 0; i < cipher_suites->size(); ++i )
				{
				Val* ciph = new Val((*cipher_suites)[i], TYPE_COUNT);
				cipher_set->Assign(ciph, 0);
				Unref(ciph);
				}
			
			BifEvent::generate_ssl_client_hello(bro_analyzer(), bro_analyzer()->Conn(),
							version, ts,
							to_string_val(session_id),
							cipher_set);
			
			delete cipher_suites;
			}
		
		return true;
		%}

	function proc_server_hello(rec: SSLRecord,
					version : uint16, ts : double,
					session_id : uint8[],
					cipher_suites16 : uint16[],
					cipher_suites24 : uint24[],
					comp_method : uint8) : bool
		%{
		if ( state_ == STATE_TRACK_LOST )
			bro_analyzer()->ProtocolViolation(fmt("unexpected server hello message from %s in state %s",
				orig_label(${rec.is_orig}).c_str(),
				state_label(old_state_).c_str()));

		if ( ! version_ok(version) )
			bro_analyzer()->ProtocolViolation(fmt("unsupported server SSL version 0x%04x", version));
		else
			bro_analyzer()->ProtocolConfirmation();

		if ( ssl_server_hello )
			{
			vector<int>* ciphers = new vector<int>();

			if ( cipher_suites16 )
				std::copy(cipher_suites16->begin(), cipher_suites16->end(), std::back_inserter(*ciphers));
			else
				std::transform(cipher_suites24->begin(), cipher_suites24->end(), std::back_inserter(*ciphers), to_int());
			
			BifEvent::generate_ssl_server_hello(bro_analyzer(),
							bro_analyzer()->Conn(),
							version, ts,
							to_string_val(session_id),
							ciphers->size()==0 ? 0 : ciphers->at(0), comp_method);
			
			delete ciphers;
			}
		
		return true;
		%}

	function proc_ssl_extension(type: int, data: bytestring) : bool
		%{
		if ( ssl_extension )
			BifEvent::generate_ssl_extension(bro_analyzer(),
						bro_analyzer()->Conn(), type,
						new StringVal(data.length(), (const char*) data.data()));
		return true;
		%}

	function proc_certificate(rec: SSLRecord, certificates : bytestring[]) : bool
		%{
		if ( state_ == STATE_TRACK_LOST )
			bro_analyzer()->ProtocolViolation(fmt("unexpected certificate message from %s in state %s",
				orig_label(${rec.is_orig}).c_str(),
				state_label(old_state_).c_str()));

		if ( certificates->size() == 0 )
			return true;

		if ( x509_certificate )
			{
			STACK_OF(X509)* untrusted_certs = 0;
			
			for ( unsigned int i = 0; i < certificates->size(); ++i )
				{
				const bytestring& cert = (*certificates)[i];
				const uint8* data = cert.data();
				X509* pTemp = d2i_X509_binpac(NULL, &data, cert.length());
				if ( ! pTemp )
					{
					BifEvent::generate_x509_error(bro_analyzer(), bro_analyzer()->Conn(),
					                              ERR_get_error());
					return false;
					}

				RecordVal* pX509Cert = new RecordVal(x509_type);
				char tmp[256];
				BIO *bio = BIO_new(BIO_s_mem());

				pX509Cert->Assign(0, new Val((uint64) X509_get_version(pTemp), TYPE_COUNT));
				i2a_ASN1_INTEGER(bio, X509_get_serialNumber(pTemp));
				int len = BIO_read(bio, &(*tmp), sizeof tmp);
				pX509Cert->Assign(1, new StringVal(len, tmp));

				X509_NAME_print_ex(bio, X509_get_subject_name(pTemp), 0, XN_FLAG_RFC2253);
				len = BIO_gets(bio, &(*tmp), sizeof tmp);
				pX509Cert->Assign(2, new StringVal(len, tmp));
				X509_NAME_print_ex(bio, X509_get_issuer_name(pTemp), 0, XN_FLAG_RFC2253);
				len = BIO_gets(bio, &(*tmp), sizeof tmp);
				pX509Cert->Assign(3, new StringVal(len, tmp));
				BIO_free(bio);

				pX509Cert->Assign(4, new Val(get_time_from_asn1(X509_get_notBefore(pTemp)), TYPE_TIME));
				pX509Cert->Assign(5, new Val(get_time_from_asn1(X509_get_notAfter(pTemp)), TYPE_TIME));
				StringVal* der_cert = new StringVal(cert.length(), (const char*) cert.data());

				BifEvent::generate_x509_certificate(bro_analyzer(), bro_analyzer()->Conn(),
							pX509Cert,
							! ${rec.is_orig},
							i, certificates->size(),
							der_cert);

				// Are there any X509 extensions?
				if ( x509_extension && X509_get_ext_count(pTemp) > 0 )
					{
					int num_ext = X509_get_ext_count(pTemp);
					for ( int k = 0; k < num_ext; ++k )
						{
						char *pBuffer = 0;
						int length = 0;

						X509_EXTENSION* ex = X509_get_ext(pTemp, k);
						if (ex)
							{
							ASN1_STRING *pString = X509_EXTENSION_get_data(ex);
							length = ASN1_STRING_to_UTF8((unsigned char**)&pBuffer, pString);
							//i2t_ASN1_OBJECT(&pBuffer, length, obj)

							// -1 indicates an error.
							if ( length < 0 )
								continue;

							StringVal* value = new StringVal(length, pBuffer);
							BifEvent::generate_x509_extension(bro_analyzer(),
										bro_analyzer()->Conn(), value);
							OPENSSL_free(pBuffer);
							}
						}
					}
				X509_free(pTemp);
				}
			}
		return true;
		%}

	function proc_v2_certificate(rec: SSLRecord, cert : bytestring) : bool
		%{
		vector<bytestring>* cert_list = new vector<bytestring>(1,cert);
		bool ret = proc_certificate(rec, cert_list);
		delete cert_list;
		return ret;
		%}

	function proc_v3_certificate(rec: SSLRecord, cl : CertificateList) : bool
		%{
		vector<X509Certificate*>* certs = cl->val();
		vector<bytestring>* cert_list = new vector<bytestring>();

		std::transform(certs->begin(), certs->end(),
		std::back_inserter(*cert_list), extract_certs());

		bool ret = proc_certificate(rec, cert_list);
		delete cert_list;
		return ret;
		%}

	function proc_v2_client_master_key(rec: SSLRecord, cipher_kind: int) : bool
		%{
		if ( state_ == STATE_TRACK_LOST )
			bro_analyzer()->ProtocolViolation(fmt("unexpected v2 client master key message from %s in state %s",
				orig_label(${rec.is_orig}).c_str(),
				state_label(old_state_).c_str()));

		BifEvent::generate_ssl_established(bro_analyzer(),
				bro_analyzer()->Conn());

		return true;
		%}

	function proc_unknown_handshake(hs: Handshake, is_orig: bool) : bool
		%{
		bro_analyzer()->ProtocolViolation(fmt("unknown handshake message (%d) from %s",
			${hs.msg_type}, orig_label(is_orig).c_str()));
		return true;
		%}

	function proc_handshake(hs: Handshake, is_orig: bool) : bool
		%{
		if ( state_ == STATE_TRACK_LOST )
			bro_analyzer()->ProtocolViolation(fmt("unexpected Handshake message %s from %s in state %s",
				handshake_type_label(${hs.msg_type}).c_str(),
				orig_label(is_orig).c_str(),
				state_label(old_state_).c_str()));
		return true;
		%}

	function proc_unknown_record(rec: SSLRecord) : bool
		%{
		bro_analyzer()->ProtocolViolation(fmt("unknown SSL record type (%d) from %s",
				${rec.content_type},
				orig_label(${rec.is_orig}).c_str()));
		return true;
		%}

	function proc_ciphertext_record(rec : SSLRecord) : bool
		%{
		if ( state_ == STATE_TRACK_LOST )
			bro_analyzer()->ProtocolViolation(fmt("unexpected ciphertext record from %s in state %s",
				orig_label(${rec.is_orig}).c_str(),
				state_label(old_state_).c_str()));

		else if ( state_ == STATE_CONN_ESTABLISHED &&
		          old_state_ == STATE_COMM_ENCRYPTED )
			{
			BifEvent::generate_ssl_established(bro_analyzer(),
							bro_analyzer()->Conn());
			}

		return true;
		%}
};

refine typeattr ChangeCipherSpec += &let {
	proc : bool = $context.connection.proc_change_cipher_spec(rec)
		&requires(state_changed);
};

refine typeattr Alert += &let {
	proc : bool = $context.connection.proc_alert(rec, level, description);
};

refine typeattr V2Error += &let {
	proc : bool = $context.connection.proc_alert(rec, -1, error_code);
};

refine typeattr ApplicationData += &let {
	proc : bool = $context.connection.proc_application_data(rec);
};

refine typeattr ClientHello += &let {
	proc : bool = $context.connection.proc_client_hello(rec, client_version,
				gmt_unix_time,
				session_id, csuits, 0)
		&requires(state_changed);
};

refine typeattr V2ClientHello += &let {
	proc : bool = $context.connection.proc_client_hello(rec, client_version, 0,
				session_id, 0, ciphers)
		&requires(state_changed);
};

refine typeattr ServerHello += &let {
	proc : bool = $context.connection.proc_server_hello(rec, server_version,
			gmt_unix_time, session_id, cipher_suite, 0,
			compression_method)
		&requires(state_changed);
};

refine typeattr V2ServerHello += &let {
	proc : bool = $context.connection.proc_server_hello(rec, server_version, 0, 0,
				0, ciphers, 0)
		&requires(state_changed);

	cert : bool = $context.connection.proc_v2_certificate(rec, cert_data)
		&requires(proc);
};

refine typeattr Certificate += &let {
	proc : bool = $context.connection.proc_v3_certificate(rec, certificates)
		&requires(state_changed);
};

refine typeattr V2ClientMasterKey += &let {
	proc : bool = $context.connection.proc_v2_client_master_key(rec, cipher_kind)
		&requires(state_changed);
};

refine typeattr UnknownHandshake += &let {
	proc : bool = $context.connection.proc_unknown_handshake(hs, is_orig);
};

refine typeattr Handshake += &let {
	proc : bool = $context.connection.proc_handshake(this, rec.is_orig);
};

refine typeattr UnknownRecord += &let {
	proc : bool = $context.connection.proc_unknown_record(rec);
};

refine typeattr CiphertextRecord += &let {
	proc : bool = $context.connection.proc_ciphertext_record(rec);
}

refine typeattr SSLExtension += &let {
	proc : bool = $context.connection.proc_ssl_extension(type, data);
};
